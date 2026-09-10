package com.spencer.echopanel.wake

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import android.util.Log
import com.spencer.echopanel.R
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import kotlin.math.sqrt

class WakeWordService : Service() {
    interface Listener {
        fun onCaptureReady(id: Int)
        fun onAudio(id: Int, pcm: ShortArray)
        fun onError(id: Int, message: String)
    }

    inner class LocalBinder : Binder() { val service get() = this@WakeWordService }
    @Volatile var listener: Listener? = null
    @Volatile private var running = false
    @Volatile private var paused = false
    @Volatile private var captureId = 0
    @Volatile private var wakePendingUntil = 0L
    @Volatile private var resetModel = true
    @Volatile private var modelRevision = 0
    @Volatile private var threshold = WakeSensitivity.DEFAULT_THRESHOLD
    @Volatile private var audioRecord: AudioRecord? = null
    private val queue = ArrayBlockingQueue<ShortArray>(8)
    private var captureThread: Thread? = null
    private var modelThread: Thread? = null
    private val prefs by lazy { getSharedPreferences("echo-panel", MODE_PRIVATE) }
    private val preferenceListener = SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
        if (key == WakeSensitivity.KEY) {
            threshold = WakeSensitivity.normalizeThreshold(prefs.getFloat(key, WakeSensitivity.DEFAULT_THRESHOLD))
            Log.i(TAG, "Wake sensitivity updated: threshold=$threshold")
        }
    }

    override fun onCreate() {
        super.onCreate()
        // Old thresholds compensated for incorrectly normalized PCM. Migrate once.
        if (prefs.getInt("wake_engine_version", 0) < 2) {
            prefs.edit().putFloat(WakeSensitivity.KEY, WakeSensitivity.DEFAULT_THRESHOLD).putInt("wake_engine_version", 2).apply()
        }
        prefs.registerOnSharedPreferenceChangeListener(preferenceListener)
        threshold = WakeSensitivity.normalizeThreshold(prefs.getFloat(WakeSensitivity.KEY, WakeSensitivity.DEFAULT_THRESHOLD))
        if (Build.VERSION.SDK_INT >= 26) {
            getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel("wake_word", getString(R.string.wake_channel_name), NotificationManager.IMPORTANCE_LOW),
            )
        }
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, "wake_word") else Notification.Builder(this)
        startForeground(42, builder.setContentTitle(getString(R.string.wake_notification_title))
            .setContentText(getString(R.string.wake_notification_ready)).setSmallIcon(R.drawable.ic_stat_mic).setOngoing(true).build())
    }

    override fun onBind(intent: Intent?): IBinder = LocalBinder()

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!running && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            running = true
            captureThread = thread(name = "EchoMicrophone") { captureLoop() }
            modelThread = thread(name = "EchoWakeInference") { inferenceLoop() }
        }
        return START_STICKY
    }

    fun setPaused(value: Boolean) {
        paused = value
        wakePendingUntil = 0L
        if (!value) resetModel = true
    }

    fun startCapture(id: Int) {
        require(id > 0)
        paused = true
        wakePendingUntil = 0L
        captureId = id
    }

    fun stopCapture(id: Int) {
        if (captureId == id) captureId = 0
    }

    fun resetClient() {
        captureId = 0
        setPaused(false)
    }

    fun reloadModels() {
        modelRevision++
        resetModel = true
        queue.clear()
    }

    @SuppressLint("MissingPermission")
    private fun captureLoop() {
        android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_AUDIO)
        while (running) {
            var recorder: AudioRecord? = null
            try {
                val minimum = AudioRecord.getMinBufferSize(16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
                recorder = AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, 16000,
                    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(minimum, 1280 * 8))
                check(recorder.state == AudioRecord.STATE_INITIALIZED) { "Microphone could not initialize" }
                audioRecord = recorder
                recorder.startRecording()
                Log.i(TAG, "Continuous microphone ready: 16000 Hz PCM16")
                var announcedId = 0
                var captureStarted = 0L
                var lastLog = 0L
                var peakRms = 0.0
                while (running) {
                    val pcm = ShortArray(OpenWakeWordModel.FRAME_SAMPLES)
                    var offset = 0
                    while (running && offset < pcm.size) {
                        val count = recorder.read(pcm, offset, pcm.size - offset)
                        check(count > 0) { "Microphone read failed ($count)" }
                        offset += count
                    }
                    if (!running) break
                    val now = SystemClock.elapsedRealtime()
                    val id = captureId
                    if (id != 0) {
                        if (announcedId != id) {
                            announcedId = id
                            captureStarted = now
                            listener?.onCaptureReady(id)
                        }
                        if (now - captureStarted > 20_000) {
                            listener?.onError(id, "Microphone capture timed out")
                            resetClient()
                        } else listener?.onAudio(id, pcm)
                    } else announcedId = 0

                    if (!paused && id == 0 && now >= wakePendingUntil) {
                        if (!queue.offer(pcm)) {
                            queue.clear()
                            resetModel = true
                            Log.w(TAG, "Wake inference fell behind; discarded stale audio")
                            queue.offer(pcm)
                        }
                    } else queue.clear()
                    var energy = 0.0
                    for (sample in pcm) energy += sample.toDouble() * sample
                    peakRms = maxOf(peakRms, sqrt(energy / pcm.size) / 32768.0)
                    if (now - lastLog >= 5000) {
                        Log.i(TAG, "Mic peakRms=$peakRms capture=$id paused=$paused queued=${queue.size}")
                        peakRms = 0.0
                        lastLog = now
                    }
                }
            } catch (error: Exception) {
                if (running) {
                    Log.e(TAG, "Microphone failed; retrying", error)
                    listener?.onError(captureId, error.message ?: "Microphone failed")
                    resetClient()
                }
            } finally {
                runCatching { recorder?.stop() }
                recorder?.release()
                audioRecord = null
            }
            if (running) Thread.sleep(1000)
        }
    }

    private fun inferenceLoop() {
        while (running) {
            val revision = modelRevision
            val path = prefs.getString("wake_model_path", "hey_jarvis_v0.1.onnx") ?: "hey_jarvis_v0.1.onnx"
            val name = prefs.getString("wake_model_name", "Hey Jarvis") ?: "Hey Jarvis"
            try {
                OpenWakeWordModel(assets, path).use { model ->
                    Log.i(TAG, "Wake models loaded once: $name threshold=$threshold")
                    var peak = 0f
                    var maxInferenceMs = 0L
                    var lastLog = 0L
                    while (running && revision == modelRevision) {
                        val pcm = queue.poll(500, TimeUnit.MILLISECONDS) ?: continue
                        if (paused || captureId != 0) continue
                        if (resetModel) { model.reset(); resetModel = false }
                        val started = SystemClock.elapsedRealtime()
                        val score = model.predict(pcm)
                        val now = SystemClock.elapsedRealtime()
                        peak = maxOf(peak, score)
                        maxInferenceMs = maxOf(maxInferenceMs, now - started)
                        if (now - lastLog >= 5000) {
                            Log.i(TAG, "Wake peak=$peak threshold=$threshold maxInferenceMs=$maxInferenceMs")
                            peak = 0f
                            maxInferenceMs = 0
                            lastLog = now
                        }
                        if (score >= threshold && !paused && captureId == 0 && now >= wakePendingUntil) {
                            wakePendingUntil = now + 8000
                            resetModel = true
                            Log.i(TAG, "Detected $name score=$score inferenceMs=${now - started}")
                            sendBroadcast(Intent(ACTION_WAKE_DETECTED).setPackage(packageName)
                                .putExtra(EXTRA_MODEL, name).putExtra(EXTRA_SCORE, score))
                        }
                    }
                }
            } catch (error: Exception) {
                if (running) {
                    Log.e(TAG, "Wake engine failed; retrying", error)
                    Thread.sleep(3000)
                }
            }
        }
    }

    override fun onDestroy() {
        running = false
        prefs.unregisterOnSharedPreferenceChangeListener(preferenceListener)
        listener = null
        runCatching { audioRecord?.stop() }
        captureThread?.join(1000)
        modelThread?.join(1000)
        super.onDestroy()
    }

    companion object {
        const val ACTION_WAKE_DETECTED = "com.spencer.echopanel.OPENWAKEWORD_DETECTED"
        const val EXTRA_MODEL = "model"
        const val EXTRA_SCORE = "score"
        private const val TAG = "WakeWordService"
    }
}

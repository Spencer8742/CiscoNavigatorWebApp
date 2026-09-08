package com.spencer.echopanel.wake

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.IBinder
import android.util.Log
import com.rementia.openwakeword.lib.WakeWordEngine
import com.rementia.openwakeword.lib.model.DetectionMode
import com.rementia.openwakeword.lib.model.WakeWordModel
import com.spencer.echopanel.R
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class WakeWordService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var engine: WakeWordEngine? = null
    private var lastScoreLogAt = 0L
    private var peakScore = 0f
    private var peakScoreAt = 0L

    override fun onCreate() {
        super.onCreate()
        Log.i(TAG, "Wake word service created")
        createChannel()
        startForeground(NOTIFICATION_ID, notification(getString(R.string.wake_notification_ready)))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.i(TAG, "Wake word service start requested")
        if (engine == null) startWakeEngine()
        return START_STICKY
    }

    override fun onDestroy() {
        Log.i(TAG, "Wake word service destroyed")
        engine?.release()
        engine = null
        scope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun startWakeEngine() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            Log.w(TAG, "RECORD_AUDIO is not granted; wake word service cannot start")
            stopSelf()
            return
        }

        val modelPath = wakeModelPath()
        val requiredAssets = listOf("melspectrogram.onnx", "embedding_model.onnx", modelPath)
        val missing = requiredAssets.filterNot(::assetExists)
        if (missing.isNotEmpty()) {
            Log.w(TAG, "Missing openWakeWord assets: ${missing.joinToString()}")
            startForeground(NOTIFICATION_ID, notification(getString(R.string.wake_notification_missing_assets)))
            return
        }

        val modelName = wakeModelName()
        val threshold = wakeThreshold()
        val models = listOf(
            WakeWordModel(
                name = modelName,
                modelPath = modelPath,
                threshold = threshold,
            ),
        )
        Log.i(TAG, "Starting wake engine model=$modelName path=$modelPath threshold=$threshold")

        val next = WakeWordEngine(
            context = this,
            models = models,
            detectionMode = DetectionMode.SINGLE_BEST,
            detectionCooldownMs = 2500L,
            scope = scope,
        )
        engine = next

        scope.launch {
            next.scores.collect { score ->
                if (score.score > peakScore) {
                    peakScore = score.score
                    peakScoreAt = score.timestamp
                }

                val now = System.currentTimeMillis()
                if (now - lastScoreLogAt >= SCORE_LOG_INTERVAL_MS) {
                    Log.i(
                        TAG,
                        "Wake score model=${score.model.name} current=${score.score} peak=$peakScore peakAt=$peakScoreAt threshold=${score.model.threshold}",
                    )
                    lastScoreLogAt = now
                    peakScore = score.score
                    peakScoreAt = score.timestamp
                }
            }
        }

        scope.launch {
            next.detections.collect { detection ->
                Log.i(TAG, "Detected ${detection.model.name} (${detection.score})")
                next.stop()
                sendBroadcast(
                    Intent(ACTION_WAKE_DETECTED)
                        .setPackage(packageName)
                        .putExtra(EXTRA_MODEL, detection.model.name)
                        .putExtra(EXTRA_SCORE, detection.score),
                )
                delay(WAKE_CAPTURE_PAUSE_MS)
                if (engine === next) next.start()
            }
        }

        next.start()
        Log.i(TAG, "Wake engine started")
    }

    private fun wakeModelName(): String {
        return getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_MODEL_NAME, "Hey Jarvis") ?: "Hey Jarvis"
    }

    private fun wakeModelPath(): String {
        val configured = getSharedPreferences(PREFS, MODE_PRIVATE)
            .getString(KEY_MODEL_PATH, "hey_jarvis_v0.1.onnx")
            ?: "hey_jarvis_v0.1.onnx"
        return configured.trim().ifEmpty { "hey_jarvis_v0.1.onnx" }
    }

    private fun wakeThreshold(): Float {
        return getSharedPreferences(PREFS, MODE_PRIVATE)
            .getFloat(KEY_THRESHOLD, DEFAULT_WAKE_THRESHOLD)
            .coerceIn(0.01f, 0.99f)
    }

    private fun assetExists(path: String): Boolean {
        return runCatching {
            assets.open(path).use { true }
        }.getOrDefault(false)
    }

    private fun notification(text: String): Notification {
        val builder = if (Build.VERSION.SDK_INT >= 26) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }

        return builder
            .setContentTitle(getString(R.string.wake_notification_title))
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_stat_mic)
            .setOngoing(true)
            .build()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < 26) return
        val manager = getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.wake_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = getString(R.string.wake_channel_description)
        }
        manager.createNotificationChannel(channel)
    }

    companion object {
        const val ACTION_WAKE_DETECTED = "com.spencer.echopanel.OPENWAKEWORD_DETECTED"
        const val EXTRA_MODEL = "model"
        const val EXTRA_SCORE = "score"

        private const val TAG = "WakeWordService"
        private const val CHANNEL_ID = "wake_word"
        private const val NOTIFICATION_ID = 42
        private const val WAKE_CAPTURE_PAUSE_MS = 15_000L
        private const val SCORE_LOG_INTERVAL_MS = 5_000L
        private const val DEFAULT_WAKE_THRESHOLD = 0.03f
        private const val PREFS = "echo-panel"
        private const val KEY_MODEL_NAME = "wake_model_name"
        private const val KEY_MODEL_PATH = "wake_model_path"
        private const val KEY_THRESHOLD = "wake_threshold"
    }
}

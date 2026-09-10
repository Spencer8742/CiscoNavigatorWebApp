package com.spencer.echopanel

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.*
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.AudioFormat
import android.media.AudioTrack
import android.net.Uri
import android.os.*
import android.util.Base64
import android.util.Log
import android.view.*
import android.webkit.*
import android.widget.FrameLayout
import android.widget.TextView
import com.spencer.echopanel.wake.WakeWordService
import com.spencer.echopanel.wake.WakeSensitivity
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.sin

private const val PERMISSION_REQUEST = 8742
private const val DEFAULT_PANEL_URL = "https://assistant.ts.blasters.app/?panel=echo-show&nativeWake=1"
private const val PREFS = "echo-panel"

class MainActivity : Activity() {
    private lateinit var webView: WebView
    private lateinit var status: TextView
    private var voice: WakeWordService? = null
    private var bound = false
    private var chime: AudioTrack? = null
    private var lastWakeAt = 0L
    private var destroyed = false

    private val audioListener = object : WakeWordService.Listener {
        override fun onCaptureReady(id: Int) {
            runOnUiThread {
                if (destroyed) return@runOnUiThread
                playListeningChime()
                audioEvent(JSONObject().put("id", id).put("type", "ready"))
            }
        }
        override fun onAudio(id: Int, pcm: ShortArray) {
            val bytes = ByteBuffer.allocate(pcm.size * 2).order(ByteOrder.LITTLE_ENDIAN)
            bytes.asShortBuffer().put(pcm)
            audioEvent(JSONObject().put("id", id).put("type", "audio")
                .put("pcm", Base64.encodeToString(bytes.array(), Base64.NO_WRAP)))
        }
        override fun onError(id: Int, message: String) {
            audioEvent(JSONObject().put("id", id).put("type", "error").put("message", message))
        }
    }

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, binder: IBinder) {
            voice = (binder as WakeWordService.LocalBinder).service.also { it.listener = audioListener }
        }
        override fun onServiceDisconnected(name: ComponentName) { voice = null }
    }

    private val wakeReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action != WakeWordService.ACTION_WAKE_DETECTED) return
            val now = SystemClock.elapsedRealtime()
            if (now - lastWakeAt < 1500) return
            lastWakeAt = now
            hideSystemUi()
            // Exactly one event. The web handler is mounted above every route and overlay.
            webView.evaluateJavascript("window.CiscoNavigatorNativeWake && window.CiscoNavigatorNativeWake()", null)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        volumeControlStream = AudioManager.STREAM_MUSIC
        applyIntentSettings(intent)
        webView = WebView(this)
        status = TextView(this).apply {
            text = "Loading Echo Panel..."
            setTextColor(0xffffffff.toInt())
            setBackgroundColor(0xff08090c.toInt())
            textSize = 18f
            gravity = Gravity.CENTER
        }
        val root = FrameLayout(this)
        val fill = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        root.addView(webView, fill)
        root.addView(status, fill)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        webView.keepScreenOn = true
        setContentView(root)
        hideSystemUi()
        configureWebView()
        webView.addJavascriptInterface(NativeBridge(), "CiscoNavigatorAndroid")
        val filter = IntentFilter(WakeWordService.ACTION_WAKE_DETECTED)
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(wakeReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        else registerReceiver(wakeReceiver, filter)
        prepareChime()
        requestRuntimePermissions()
        webView.loadUrl(panelUrl())
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (applyIntentSettings(intent)) {
            voice?.resetClient()
            if (listOf("wake_model_name", "wake_model_path").any { intent.hasExtra(it) })
                voice?.reloadModels()
            webView.loadUrl(panelUrl())
        }
    }

    override fun onDestroy() {
        destroyed = true
        unregisterReceiver(wakeReceiver)
        voice?.listener = null
        voice?.resetClient()
        if (bound) unbindService(connection)
        chime?.release()
        webView.destroy()
        super.onDestroy()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemUi()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == PERMISSION_REQUEST && hasAudioPermission()) startVoiceService()
    }

    override fun onBackPressed() {
        webView.evaluateJavascript("document.querySelector('[role=dialog] [aria-label=Close]')?.click()", null)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            useWideViewPort = true
            setSupportZoom(false)
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                if (trusted(request.origin) && request.resources.all { it == PermissionRequest.RESOURCE_AUDIO_CAPTURE } && hasAudioPermission())
                    request.grant(request.resources)
                else request.deny()
            }
        }
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = !trusted(request.url)

            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                voice?.resetClient()
            }

            override fun onPageFinished(view: WebView, url: String) {
                status.visibility = View.GONE
                view.evaluateJavascript("window.CiscoNavigatorNative = true", null)
            }

            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                if (request.method != "GET" || !trusted(request.url)) return null
                val path = request.url.path ?: return null
                val asset = when {
                    path == "/" || path == "/index.html" -> "panel/index.html"
                    path.startsWith("/a/") && !path.contains("..") -> "panel" + path
                    else -> return null
                }
                val mime = when {
                    asset.endsWith(".html") -> "text/html"
                    asset.endsWith(".js") -> "application/javascript"
                    asset.endsWith(".css") -> "text/css"
                    asset.endsWith(".woff2") -> "font/woff2"
                    asset.endsWith(".svg") -> "image/svg+xml"
                    else -> "application/octet-stream"
                }
                return runCatching {
                    WebResourceResponse(mime, "utf-8", 200, "OK", mapOf("Cache-Control" to "no-store"), assets.open(asset))
                }.getOrNull()
            }
        }
    }

    private fun trusted(uri: Uri): Boolean {
        val panel = Uri.parse(panelUrl())
        return uri.scheme == panel.scheme && uri.host == panel.host && uri.port == panel.port
    }

    private fun panelUrl(): String {
        val configured = getSharedPreferences(PREFS, MODE_PRIVATE).getString("panel_url", DEFAULT_PANEL_URL) ?: DEFAULT_PANEL_URL
        val parsed = Uri.parse(configured)
        val builder = parsed.buildUpon()
        if (parsed.getQueryParameter("nativeWake") == null) builder.appendQueryParameter("nativeWake", "1")
        return builder.build().toString()
    }

    private fun requestRuntimePermissions() {
        val missing = mutableListOf<String>()
        if (!hasAudioPermission()) missing += Manifest.permission.RECORD_AUDIO
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            missing += Manifest.permission.POST_NOTIFICATIONS
        if (missing.isEmpty()) startVoiceService() else requestPermissions(missing.toTypedArray(), PERMISSION_REQUEST)
    }

    private fun hasAudioPermission() = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    private fun startVoiceService() {
        val intent = Intent(this, WakeWordService::class.java)
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(intent) else startService(intent)
        if (!bound) bound = bindService(intent, connection, Context.BIND_AUTO_CREATE)
    }

    private fun applyIntentSettings(intent: Intent?): Boolean {
        if (intent == null) return false
        val editor = getSharedPreferences(PREFS, MODE_PRIVATE).edit()
        var changed = false
        for (key in listOf("panel_url", "wake_model_name", "wake_model_path")) {
            intent.getStringExtra(key)?.trim()?.takeIf { it.isNotEmpty() }?.let {
                if (key != "panel_url" || it.startsWith("https://")) {
                    editor.putString(key, it)
                    changed = true
                }
            }
        }
        if (intent.hasExtra("wake_threshold")) {
            editor.putFloat(WakeSensitivity.KEY, WakeSensitivity.normalizeThreshold(
                intent.getFloatExtra(WakeSensitivity.KEY, WakeSensitivity.DEFAULT_THRESHOLD)))
            changed = true
        }
        if (changed) editor.apply()
        return changed
    }

    private inner class NativeBridge {
        @JavascriptInterface fun audioVersion(): Int = 1
        @JavascriptInterface fun wakeSensitivity(): Int = WakeSensitivity.fromThreshold(
            getSharedPreferences(PREFS, MODE_PRIVATE).getFloat(WakeSensitivity.KEY, WakeSensitivity.DEFAULT_THRESHOLD))
        @JavascriptInterface fun setWakeSensitivity(value: Int): Int {
            val threshold = WakeSensitivity.toThreshold(value)
            // JavascriptInterface calls run off the UI thread. Report a failed disk write.
            val saved = getSharedPreferences(PREFS, MODE_PRIVATE).edit().putFloat(WakeSensitivity.KEY, threshold).commit()
            return if (saved) WakeSensitivity.fromThreshold(threshold) else -1
        }
        @JavascriptInterface fun startCapture(id: Int) {
            runOnUiThread {
                val service = voice
                if (service == null) audioListener.onError(id, "Microphone is starting; try again")
                else service.startCapture(id)
            }
        }
        @JavascriptInterface fun stopCapture(id: Int) { runOnUiThread { voice?.stopCapture(id) } }
        @JavascriptInterface fun setWakePaused(paused: Boolean) { runOnUiThread { voice?.setPaused(paused) } }
        @JavascriptInterface fun playTimerAlert() { runOnUiThread { if (!destroyed) playListeningChime() } }
    }

    private fun audioEvent(event: JSONObject) {
        runOnUiThread {
            if (!destroyed) webView.evaluateJavascript("window.CiscoNavigatorNativeAudio && window.CiscoNavigatorNativeAudio($event)", null)
        }
    }

    private fun prepareChime() {
        runCatching {
            val rate = 48000
            // Include a short lead-in and tail so the Echo amplifier has time to wake.
            val pcm = ShortArray(rate * 600 / 1000) { i ->
                val t = i.toDouble() / rate - 0.06
                if (t < 0 || t > 0.22) 0 else {
                    val envelope = sin(PI * t / 0.22)
                    (sin(2 * PI * (880 * t + 700 * t * t)) * envelope * 18000).toInt().toShort()
                }
            }
            chime = AudioTrack.Builder()
                .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                .setAudioFormat(AudioFormat.Builder().setSampleRate(rate).setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                .setTransferMode(AudioTrack.MODE_STATIC).setBufferSizeInBytes(pcm.size * 2).build().also {
                    check(it.write(pcm, 0, pcm.size) == pcm.size)
                }
        }.onFailure { Log.e("MainActivity", "Chime initialization failed", it) }
    }

    private fun playListeningChime() {
        runCatching {
            chime?.apply { stop(); reloadStaticData(); setPlaybackHeadPosition(0); play() }
            Log.i("MainActivity", "Listening chime started")
        }.onFailure { Log.e("MainActivity", "Chime playback failed", it) }
    }

    private fun hideSystemUi() {
        if (Build.VERSION.SDK_INT >= 30) window.decorView.windowInsetsController?.hide(WindowInsets.Type.systemBars())
        else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
        }
    }
}

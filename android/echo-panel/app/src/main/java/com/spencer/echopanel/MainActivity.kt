package com.spencer.echopanel

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.TextView
import com.spencer.echopanel.wake.WakeWordService

private const val PERMISSION_REQUEST = 8742
private const val DEFAULT_PANEL_URL = "https://assistant.ts.blasters.app/?panel=echo-show&nativeWake=1"
private const val PREFS = "echo-panel"
private const val EXTRA_PANEL_URL = "panel_url"
private const val EXTRA_WAKE_MODEL_NAME = "wake_model_name"
private const val EXTRA_WAKE_MODEL_PATH = "wake_model_path"
private const val EXTRA_WAKE_THRESHOLD = "wake_threshold"

class MainActivity : Activity() {
    private lateinit var webView: WebView
    private lateinit var status: TextView

    private val wakeReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action == WakeWordService.ACTION_WAKE_DETECTED) {
                triggerAssistFromWake()
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        applyIntentSettings(intent)

        val root = FrameLayout(this)
        webView = WebView(this)
        status = TextView(this).apply {
            text = "Loading Echo Panel..."
            setTextColor(0xffffffff.toInt())
            setBackgroundColor(0xff08090c.toInt())
            textSize = 18f
            gravity = android.view.Gravity.CENTER
        }
        root.addView(
            webView,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
        root.addView(
            status,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        webView.keepScreenOn = true
        setContentView(root)
        hideSystemUi()

        configureWebView()
        webView.addJavascriptInterface(NativeBridge(), "CiscoNavigatorAndroid")
        registerWakeReceiver()
        requestRuntimePermissions()
        loadPanel()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (applyIntentSettings(intent)) {
            loadPanel()
            restartWakeService()
        }
    }

    override fun onDestroy() {
        unregisterReceiver(wakeReceiver)
        webView.destroy()
        super.onDestroy()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemUi()
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == PERMISSION_REQUEST && hasAudioPermission()) startWakeService()
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        WebView.setWebContentsDebuggingEnabled(true)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            loadWithOverviewMode = false
            useWideViewPort = true
            builtInZoomControls = false
            displayZoomControls = false
            setSupportZoom(false)
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                val audioOnly = request.resources.all { it == PermissionRequest.RESOURCE_AUDIO_CAPTURE }
                if (audioOnly && hasAudioPermission()) request.grant(request.resources)
                else request.deny()
            }
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                return false
            }

            override fun onPageFinished(view: WebView, url: String) {
                status.visibility = View.GONE
                injectNativeWakeBridge()
            }
        }
    }

    private fun loadPanel() {
        webView.loadUrl(panelUrl())
    }

    private fun panelUrl(): String {
        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        val configured = prefs.getString("panel_url", DEFAULT_PANEL_URL) ?: DEFAULT_PANEL_URL
        val parsed = Uri.parse(configured)
        val builder = parsed.buildUpon()
        if (parsed.getQueryParameter("nativeWake") == null) builder.appendQueryParameter("nativeWake", "1")
        return builder.build().toString()
    }

    private fun injectNativeWakeBridge() {
        webView.evaluateJavascript(
            """
            window.CiscoNavigatorNative = true;
            window.CiscoNavigatorNativeWake = window.CiscoNavigatorNativeWake || function() {
              window.dispatchEvent(new CustomEvent('navigator-native-wake'));
            };
            window.CiscoNavigatorNativePauseWake = function() {
              if (window.CiscoNavigatorAndroid) window.CiscoNavigatorAndroid.pauseWakeListening();
            };
            window.CiscoNavigatorNativeResumeWake = function() {
              if (window.CiscoNavigatorAndroid) window.CiscoNavigatorAndroid.resumeWakeListening();
            };
            (function() {
              var media = navigator.mediaDevices;
              if (!media || typeof media.getUserMedia !== 'function' || media.__CiscoNavigatorWakePatched) return;
              var originalGetUserMedia = media.getUserMedia.bind(media);
              Object.defineProperty(media, '__CiscoNavigatorWakePatched', { value: true });
              media.getUserMedia = async function(constraints) {
                var wantsAudio = !!(constraints && constraints.audio);
                if (!wantsAudio) return originalGetUserMedia(constraints);

                window.CiscoNavigatorNativePauseWake();
                await new Promise(function(resolve) { setTimeout(resolve, 250); });

                try {
                  var stream = await originalGetUserMedia(constraints);
                  var tracks = typeof stream.getAudioTracks === 'function' ? stream.getAudioTracks() : [];
                  var resumed = false;
                  var maybeResumeWake = function() {
                    if (resumed) return;
                    if (!tracks.every(function(track) { return track.readyState === 'ended'; })) return;
                    resumed = true;
                    setTimeout(function() { window.CiscoNavigatorNativeResumeWake(); }, 250);
                  };
                  tracks.forEach(function(track) {
                    var originalStop = track.stop.bind(track);
                    track.stop = function() {
                      originalStop();
                      maybeResumeWake();
                    };
                    if (typeof track.addEventListener === 'function') {
                      track.addEventListener('ended', maybeResumeWake);
                    }
                  });
                  return stream;
                } catch (err) {
                  window.CiscoNavigatorNativeResumeWake();
                  throw err;
                }
              };
            })();
            """.trimIndent(),
            null,
        )
    }

    private fun triggerAssistFromWake() {
        runOnUiThread {
            hideSystemUi()
            webView.evaluateJavascript(
                """
                window.dispatchEvent(new CustomEvent('navigator-native-wake', {
                  detail: { source: 'openwakeword' }
                }));
                """.trimIndent(),
                null,
            )
        }
    }

    private fun requestRuntimePermissions() {
        val missing = mutableListOf<String>()
        if (!hasAudioPermission()) missing += Manifest.permission.RECORD_AUDIO
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            missing += Manifest.permission.POST_NOTIFICATIONS
        }

        if (missing.isEmpty()) startWakeService()
        else requestPermissions(missing.toTypedArray(), PERMISSION_REQUEST)
    }

    private fun hasAudioPermission(): Boolean {
        return checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
    }

    private fun startWakeService() {
        val intent = Intent(this, WakeWordService::class.java)
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(intent)
        else startService(intent)
    }

    private fun restartWakeService() {
        stopService(Intent(this, WakeWordService::class.java))
        if (hasAudioPermission()) startWakeService()
    }

    private fun applyIntentSettings(intent: Intent?): Boolean {
        if (intent == null) return false

        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        val editor = prefs.edit()
        var changed = false

        intent.getStringExtra(EXTRA_PANEL_URL)?.trim()?.takeIf { it.startsWith("https://") }?.let {
            editor.putString(EXTRA_PANEL_URL, it)
            changed = true
        }
        intent.getStringExtra(EXTRA_WAKE_MODEL_NAME)?.trim()?.takeIf { it.isNotEmpty() }?.let {
            editor.putString(EXTRA_WAKE_MODEL_NAME, it)
            changed = true
        }
        intent.getStringExtra(EXTRA_WAKE_MODEL_PATH)?.trim()?.takeIf { it.endsWith(".onnx") }?.let {
            editor.putString(EXTRA_WAKE_MODEL_PATH, it)
            changed = true
        }
        if (intent.hasExtra(EXTRA_WAKE_THRESHOLD)) {
            editor.putFloat(EXTRA_WAKE_THRESHOLD, intent.getFloatExtra(EXTRA_WAKE_THRESHOLD, 0.5f).coerceIn(0.01f, 0.99f))
            changed = true
        }

        if (changed) editor.apply()
        return changed
    }

    private fun registerWakeReceiver() {
        val filter = IntentFilter(WakeWordService.ACTION_WAKE_DETECTED)
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(wakeReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        else registerReceiver(wakeReceiver, filter)
    }

    private fun hideSystemUi() {
        if (Build.VERSION.SDK_INT >= 30) {
            window.decorView.windowInsetsController?.hide(
                WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars(),
            )
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility =
                View.SYSTEM_UI_FLAG_FULLSCREEN or
                    View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                    View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
                    View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE
        }
    }

    private inner class NativeBridge {
        @JavascriptInterface
        fun pauseWakeListening() {
            Log.i(TAG, "Pausing native wake listening for WebView audio capture")
            runOnUiThread {
                stopService(Intent(this@MainActivity, WakeWordService::class.java))
            }
        }

        @JavascriptInterface
        fun resumeWakeListening() {
            Log.i(TAG, "Resuming native wake listening after WebView audio capture")
            runOnUiThread {
                if (hasAudioPermission()) startWakeService()
            }
        }
    }

    companion object {
        private const val TAG = "MainActivity"
    }
}

package com.spencer.echopanel.wake

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_MY_PACKAGE_REPLACED) return

        val service = Intent(context, WakeWordService::class.java)
        runCatching {
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(service)
            else context.startService(service)
        }.onFailure {
            Log.w("BootReceiver", "Could not start wake word service from $action", it)
        }
    }
}

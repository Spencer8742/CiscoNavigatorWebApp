package com.spencer.echopanel.wake

import kotlin.math.roundToInt

object WakeSensitivity {
    const val KEY = "wake_threshold"
    const val DEFAULT_THRESHOLD = 0.15f

    fun normalizeThreshold(value: Float): Float =
        if (value.isFinite()) value.coerceIn(0.01f, 0.99f) else DEFAULT_THRESHOLD

    // The UI increases sensitivity left to right; the model needs the inverse.
    fun fromThreshold(value: Float): Int = ((1f - normalizeThreshold(value)) * 100).roundToInt()
    fun toThreshold(value: Int): Float = (100 - value.coerceIn(1, 99)) / 100f
}

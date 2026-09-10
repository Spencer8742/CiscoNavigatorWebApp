package com.spencer.echopanel.wake

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WakeSensitivityTest {
    @Test fun defaultPreservesTheExistingThreshold() {
        assertEquals(85, WakeSensitivity.fromThreshold(WakeSensitivity.DEFAULT_THRESHOLD))
        assertEquals(0.15f, WakeSensitivity.toThreshold(85), 0.000001f)
    }

    @Test fun higherSensitivityLowersTheThresholdAndRoundTrips() {
        for (value in 1..99) {
            assertEquals(value, WakeSensitivity.fromThreshold(WakeSensitivity.toThreshold(value)))
            if (value > 1) assertTrue(WakeSensitivity.toThreshold(value) < WakeSensitivity.toThreshold(value - 1))
        }
    }

    @Test fun invalidValuesAreBounded() {
        assertEquals(0.99f, WakeSensitivity.toThreshold(Int.MIN_VALUE), 0f)
        assertEquals(0.01f, WakeSensitivity.toThreshold(Int.MAX_VALUE), 0f)
        assertEquals(99, WakeSensitivity.fromThreshold(-1f))
        assertEquals(1, WakeSensitivity.fromThreshold(2f))
        for (value in listOf(Float.NaN, Float.NEGATIVE_INFINITY, Float.POSITIVE_INFINITY)) {
            assertEquals(85, WakeSensitivity.fromThreshold(value))
        }
    }
}

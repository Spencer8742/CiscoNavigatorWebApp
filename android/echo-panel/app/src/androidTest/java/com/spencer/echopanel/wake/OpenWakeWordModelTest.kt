package com.spencer.echopanel.wake

import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder

class OpenWakeWordModelTest {
    @Test fun silenceAndSynthesizedWakePhrase() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val assets = instrumentation.targetContext.assets
        OpenWakeWordModel(assets, "hey_jarvis_v0.1.onnx").use { model ->
            repeat(40) { assertTrue("Silence triggered a wake", model.predict(ShortArray(1280)) < 0.15f) }
            val wave = instrumentation.context.assets.open("hey-jarvis.wav").use { it.readBytes() }
            val header = ByteBuffer.wrap(wave).order(ByteOrder.LITTLE_ENDIAN)
            var offset = 12
            while (String(wave, offset, 4, Charsets.US_ASCII) != "data") {
                val size = header.getInt(offset + 4)
                offset += 8 + size + (size % 2)
            }
            val count = header.getInt(offset + 4) / 2
            val pcm = ShortArray(count) { header.getShort(offset + 8 + it * 2) }
            var peak = 0f
            for (start in pcm.indices step 1280) {
                val frame = ShortArray(1280)
                pcm.copyInto(frame, 0, start, minOf(start + 1280, pcm.size))
                peak = maxOf(peak, model.predict(frame))
            }
            repeat(25) { peak = maxOf(peak, model.predict(ShortArray(1280))) }
            android.util.Log.i("WakeModelTest", "Synthesized Hey Jarvis peak=$peak")
            assertTrue("Wake phrase was not recognized: $peak", peak >= 0.15f)
            model.reset()
            repeat(40) { assertTrue("Reset retained wake audio", model.predict(ShortArray(1280)) < 0.15f) }
        }
    }
}

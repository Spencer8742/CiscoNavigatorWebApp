// Streaming feature layout adapted from openWakeWord (Apache-2.0).
// Copyright 2022 David Scripka. See THIRD_PARTY_NOTICES.md.
package com.spencer.echopanel.wake

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import ai.onnxruntime.TensorInfo
import android.content.res.AssetManager
import java.nio.FloatBuffer

/** One worker owns all sessions and buffers; input is 16 kHz signed PCM, not normalized floats. */
class OpenWakeWordModel(private val assets: AssetManager, modelPath: String) : AutoCloseable {
    private val environment = OrtEnvironment.getEnvironment()
    private val sessions = mutableListOf<OrtSession>()
    private fun session(path: String): OrtSession = OrtSession.SessionOptions().use { options ->
        options.setIntraOpNumThreads(1)
        options.setInterOpNumThreads(1)
        assets.open(path).use { environment.createSession(it.readBytes(), options) }.also(sessions::add)
    }

    private val mel: OrtSession
    private val embedding: OrtSession
    private val classifier: OrtSession
    private val featureFrames: Int
    private val audio = FloatArray(FRAME_SAMPLES + 480)
    private val spectrogram = FloatArray(76 * 32) { 1f }
    private val features: FloatArray
    private var frames = 0

    init {
        try {
            mel = session("melspectrogram.onnx")
            embedding = session("embedding_model.onnx")
            classifier = session(modelPath)
            val shape = (classifier.inputInfo.values.first().info as TensorInfo).shape
            require(shape.size == 3 && shape[1] in 1..120 && shape[2] == 96L) { "Unsupported wake model shape" }
            featureFrames = shape[1].toInt()
            features = FloatArray(featureFrames * 96)
        } catch (error: Exception) {
            close()
            throw error
        }
    }

    fun reset() {
        audio.fill(0f)
        spectrogram.fill(1f)
        features.fill(0f)
        frames = 0
    }

    fun predict(pcm: ShortArray): Float {
        require(pcm.size == FRAME_SAMPLES)
        audio.copyInto(audio, 0, FRAME_SAMPLES, audio.size)
        for (i in pcm.indices) audio[480 + i] = pcm[i].toFloat()
        val nextMel = run(mel, audio, longArrayOf(1, audio.size.toLong()))
        require(nextMel.size == 8 * 32) { "Unexpected mel output: ${nextMel.size}" }
        spectrogram.copyInto(spectrogram, 0, nextMel.size, spectrogram.size)
        for (i in nextMel.indices) spectrogram[spectrogram.size - nextMel.size + i] = nextMel[i] / 10f + 2f
        val nextEmbedding = run(embedding, spectrogram, longArrayOf(1, 76, 32, 1))
        require(nextEmbedding.size == 96) { "Unexpected embedding output" }
        features.copyInto(features, 0, 96, features.size)
        nextEmbedding.copyInto(features, features.size - 96)
        frames++
        // Ignore incomplete history after boot or an audio discontinuity.
        if (frames < featureFrames + 9) return 0f
        return run(classifier, features, longArrayOf(1, featureFrames.toLong(), 96))[0]
    }

    private fun run(session: OrtSession, input: FloatArray, shape: LongArray): FloatArray =
        OnnxTensor.createTensor(environment, FloatBuffer.wrap(input), shape).use { tensor ->
            session.run(mapOf(session.inputNames.first() to tensor)).use { result ->
                val buffer = (result[0] as OnnxTensor).floatBuffer
                FloatArray(buffer.remaining()).also(buffer::get)
            }
        }

    override fun close() {
        sessions.asReversed().forEach { it.close() }
        sessions.clear()
    }

    companion object {
        const val FRAME_SAMPLES = 1280
    }
}

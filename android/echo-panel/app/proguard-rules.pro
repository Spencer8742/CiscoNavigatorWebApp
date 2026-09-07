# Keep ONNX-backed wake-word model classes intact for release builds.
-keep class com.rementia.openwakeword.** { *; }
-keep class ai.onnxruntime.** { *; }

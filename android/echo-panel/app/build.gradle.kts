plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.spencer.echopanel"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.spencer.echopanel"
        minSdk = 23
        targetSdk = 35
        versionCode = 10
        versionName = "1.9"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("xyz.rementia:openwakeword:0.1.5")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
}

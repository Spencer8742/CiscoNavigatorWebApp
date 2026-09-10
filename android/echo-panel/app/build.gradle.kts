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
        versionCode = 14
        versionName = "2.2"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
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

    buildFeatures { buildConfig = true }
    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/panelAssets"))
}

val bundlePanel by tasks.registering(Sync::class) {
    from("../../../panel/dist") { exclude("**/*.map") }
    into(layout.buildDirectory.dir("generated/panelAssets/panel"))
    doFirst { check(file("../../../panel/dist/index.html").exists()) { "Run npm run build --workspace panel first" } }
}
tasks.named("preBuild") { dependsOn(bundlePanel) }

dependencies {
    testImplementation("junit:junit:4.13.2")
    implementation("com.microsoft.onnxruntime:onnxruntime-android:1.18.0")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("junit:junit:4.13.2")
}

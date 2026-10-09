import type { ExpoConfig } from "expo/config";

import { loadRepoEnv } from "../../scripts/lib/public-config.ts";

type AppVariant = "development" | "preview" | "production";

const repoEnv = loadRepoEnv();
Object.assign(process.env, repoEnv);

const APP_VARIANT = resolveAppVariant(repoEnv.APP_VARIANT);
// This checkout builds the personal client for every EAS variant.
const isPersonalClient = true;
const isIosPersonalTeamBuild = repoEnv.T3CODE_IOS_PERSONAL_TEAM === "1";
const runtimeVersionPolicy =
  process.env.MOBILE_VERSION_POLICY ??
  (APP_VARIANT === "development" ? "appVersion" : "fingerprint");

const personalTeamBundleIdentifier = repoEnv.T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID?.trim();
const IOS_BUNDLE_IDENTIFIER_PATTERN = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

if (
  isIosPersonalTeamBuild &&
  (!personalTeamBundleIdentifier ||
    !IOS_BUNDLE_IDENTIFIER_PATTERN.test(personalTeamBundleIdentifier))
) {
  throw new Error(
    "T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID must be a reverse-DNS identifier such as com.example.t3code when T3CODE_IOS_PERSONAL_TEAM=1.",
  );
}

// This fork ships as T3 Agents: every variant uses the Agents mark from
// assets/agents/source.png (the desktop icon), told apart by name only. iOS
// gets a full-bleed square because it applies its own mask; Android gets the
// mark alone over a navy adaptive background so the launcher mask never crops it.
const AGENTS_NAVY = "#0A1442";
const AGENTS_ASSETS = {
  appIcon: "./assets/agents/ios-icon-1024.png",
  iosIcon: "./assets/agents/ios-icon-1024.png",
  // The mark alone on a full navy screen, so the splash never shows a boxed icon.
  splashIcon: "./assets/agents/splash-mark.png",
  androidAdaptiveForeground: "./assets/agents/android-icon-foreground.png",
  androidAdaptiveBackgroundColor: AGENTS_NAVY,
  androidAdaptiveBackgroundImage: undefined,
  androidSplashIcon: "./assets/agents/android-splash-icon.png",
  androidMonochromeIcon: "./assets/agents/android-icon-monochrome.png",
  androidNotificationIcon: "./assets/agents/android-notification-icon.png",
  androidNotificationColor: AGENTS_NAVY,
} as const;

const VARIANT_CONFIG = {
  development: {
    appName: "T3 Agents Dev",
    scheme: "t3code-personal-dev",
    iosBundleIdentifier: "com.jayleaton.t3code.dev",
    androidPackage: "com.jayleaton.t3code.dev",
    relyingParty: "clerk.t3.codes",
    assets: AGENTS_ASSETS,
  },
  preview: {
    appName: "T3 Agents Preview",
    scheme: "t3code-personal-preview",
    iosBundleIdentifier: "com.jayleaton.t3code.preview",
    androidPackage: "com.jayleaton.t3code.preview",
    relyingParty: "clerk.t3.codes",
    assets: AGENTS_ASSETS,
  },
  production: {
    appName: "T3 Agents",
    scheme: "t3code-personal",
    iosBundleIdentifier: "com.jayleaton.t3code",
    androidPackage: "com.jayleaton.t3code",
    relyingParty: "clerk.t3.codes",
    assets: AGENTS_ASSETS,
  },
} as const;

function resolveAppVariant(value: string | undefined): AppVariant {
  switch (value) {
    case "development":
    case "preview":
    case "production":
      return value;
    default:
      return "production";
  }
}

const variant = VARIANT_CONFIG[APP_VARIANT];
const iosBundleIdentifier = isIosPersonalTeamBuild
  ? personalTeamBundleIdentifier!
  : variant.iosBundleIdentifier;

const dmSansFonts = {
  regular: "@expo-google-fonts/dm-sans/400Regular/DMSans_400Regular.ttf",
  medium: "@expo-google-fonts/dm-sans/500Medium/DMSans_500Medium.ttf",
  bold: "@expo-google-fonts/dm-sans/700Bold/DMSans_700Bold.ttf",
} as const;

const widgetsPlugin: NonNullable<ExpoConfig["plugins"]>[number] = [
  "expo-widgets",
  {
    bundleIdentifier: `${iosBundleIdentifier}.widgets`,
    groupIdentifier: `group.${iosBundleIdentifier}`,
    enablePushNotifications: true,
    // Agent activity can update many times an hour; without the
    // frequent-updates entitlement iOS throttles the update budget sooner.
    frequentUpdates: true,
    enableAndroid: true,
    widgets: [
      {
        name: "SubscriptionUsage",
        displayName: "Subscription usage",
        description: "Subscription quotas from your connected T3 Code environments.",
        ios: {
          configuration: {
            title: "Subscription usage",
            description:
              "Both shows Session and Weekly when available. The Lock Screen shows the tightest selected limit.",
            parameters: {
              codexPeriod: {
                title: "Codex limits",
                type: "enum",
                default: "auto",
                values: [
                  { name: "Both", value: "auto" },
                  { name: "Session", value: "session" },
                  { name: "Weekly", value: "weekly" },
                ],
              },
              claudePeriod: {
                title: "Claude limits",
                type: "enum",
                default: "auto",
                values: [
                  { name: "Both", value: "auto" },
                  { name: "Session", value: "session" },
                  { name: "Weekly", value: "weekly" },
                ],
              },
            },
          },
          supportedFamilies: [
            "systemSmall",
            "systemMedium",
            "systemLarge",
            "systemExtraLarge",
            "accessoryRectangular",
          ],
        },
        android: {
          minWidth: 250,
          minHeight: 180,
          targetCellWidth: 4,
          targetCellHeight: 3,
          resizeMode: "both",
          // Embeds the layout in the APK so the widget renders before the app
          // has run once; the app replaces it with stored props on publish.
          initialLayout: "./src/widgets/SubscriptionUsage.android.tsx",
        },
      },
      {
        name: "AgentActivity",
        displayName: "Agent Activity",
        description: "Shows the current state of active agents.",
        // Live Activity companion; there is no Android presentation for it.
        android: null,
        ios: { supportedFamilies: ["systemSmall", "systemMedium", "accessoryRectangular"] },
      },
    ],
  },
];

const sharingPlugin: NonNullable<ExpoConfig["plugins"]>[number] = [
  "expo-sharing",
  {
    ios: {
      // Personal Teams cannot sign App Groups or extension targets. Keep the
      // reduced-capability local build usable while release builds expose the
      // real system share target.
      enabled: !isIosPersonalTeamBuild,
      extensionBundleIdentifier: `${iosBundleIdentifier}.sharing`,
      appGroupId: `group.${iosBundleIdentifier}`,
      activationRule: {
        supportsText: true,
        supportsWebUrlWithMaxCount: 1,
        supportsImageWithMaxCount: 8,
        supportsMovieWithMaxCount: 8,
        supportsFileWithMaxCount: 8,
      },
    },
    android: {
      enabled: true,
      singleShareMimeTypes: ["*/*"],
      multipleShareMimeTypes: ["*/*"],
    },
  },
];

// These aliases match the fonts' PostScript names on iOS. Register the same
// names on Android so React Native and the native composer use one set of
// family names without waiting for runtime font loading.

const config: ExpoConfig = {
  name: variant.appName,
  slug: "t3-code-personal",
  platforms: ["ios", "android"],
  scheme: variant.scheme,
  version: "2.0.0",
  runtimeVersion: {
    // Development manifests resolve on every launch, so avoid fingerprint's
    // expensive native-project calculation there. Preview and production stay
    // fingerprinted so OTAs only reach binaries with matching native projects.
    policy: runtimeVersionPolicy,
  },
  orientation: "portrait",
  icon: variant.assets.appIcon,
  userInterfaceStyle: "automatic",
  updates: {
    enabled: repoEnv.T3CODE_MOBILE_UPDATES_ENABLED !== "0",
    url: "https://u.expo.dev/263247b1-0330-46c5-ac6a-7efcba44c359",
    checkAutomatically: "ON_LOAD",
    fallbackToCacheTimeout: 0,
  },
  ios: {
    icon: variant.assets.iosIcon,
    supportsTablet: true,
    // Multitasking-capable iPad apps cannot rotate programmatically, so the
    // showcase capture build requires full screen (see infoPlist below).
    requireFullScreen: process.env.T3_SHOWCASE_CAPTURE_BUILD === "1",
    bundleIdentifier: iosBundleIdentifier,
    appleTeamId: isIosPersonalTeamBuild ? undefined : "4RVGYA25L8",
    associatedDomains: [],
    entitlements: {
      "keychain-access-groups": [`$(AppIdentifierPrefix)${iosBundleIdentifier}`],
    },
    infoPlist: {
      NSAppTransportSecurity: {
        NSAllowsArbitraryLoads: true,
      },
      NSLocalNetworkUsageDescription:
        "Allow T3 Agents to connect to T3 Code servers on your local network or tailnet.",
      NSPhotoLibraryAddUsageDescription: "Allow T3 Agents to save images to your photo library.",
      // "Audio, AirPlay, and Picture in Picture": the browser screen's system
      // picture in picture needs it to start and to stay up outside the app.
      UIBackgroundModes: ["audio"],
      ITSAppUsesNonExemptEncryption: false,
      // The App Store screenshot harness rotates the iPad interface from
      // inside the app (CI denies osascript the Accessibility access that
      // Simulator menu scripting needs), and iPadOS ignores programmatic
      // orientation requests for multitasking-capable apps — so the capture
      // build opts out of multitasking and declares landscape support.
      ...(process.env.T3_SHOWCASE_CAPTURE_BUILD === "1"
        ? {
            "UISupportedInterfaceOrientations~ipad": [
              "UIInterfaceOrientationPortrait",
              "UIInterfaceOrientationPortraitUpsideDown",
              "UIInterfaceOrientationLandscapeLeft",
              "UIInterfaceOrientationLandscapeRight",
            ],
          }
        : {}),
    },
  },
  android: {
    icon: variant.assets.appIcon,
    package: variant.androidPackage,
    adaptiveIcon: {
      backgroundColor: variant.assets.androidAdaptiveBackgroundColor,
      ...(variant.assets.androidAdaptiveBackgroundImage
        ? { backgroundImage: variant.assets.androidAdaptiveBackgroundImage }
        : {}),
      foregroundImage: variant.assets.androidAdaptiveForeground,
      monochromeImage: variant.assets.androidMonochromeIcon,
    },
    // Opts into OnBackInvokedCallback-based back dispatch (Android 13+).
    // JS back handling survives it via react-native's Android 16 shim plus
    // withAndroidPredictiveBackCompat on Android 13-15.
    predictiveBackGestureEnabled: true,
    // expo-sensors declares this for its pedometer, which the app does not use.
    blockedPermissions: ["android.permission.ACTIVITY_RECOGNITION"],
  },
  web: {
    favicon: variant.assets.appIcon,
  },
  plugins: [
    "expo-asset",
    [
      "expo-font",
      {
        ios: {
          fonts: [dmSansFonts.regular, dmSansFonts.medium, dmSansFonts.bold],
        },
        android: {
          fonts: [
            {
              fontFamily: "DMSans-Regular",
              fontDefinitions: [{ path: dmSansFonts.regular, weight: 400 }],
            },
            {
              fontFamily: "DMSans-Medium",
              fontDefinitions: [{ path: dmSansFonts.medium, weight: 500 }],
            },
            {
              fontFamily: "DMSans-Bold",
              fontDefinitions: [{ path: dmSansFonts.bold, weight: 700 }],
            },
          ],
        },
      },
    ],
    "expo-secure-store",
    "expo-sqlite",
    ...(isIosPersonalTeamBuild
      ? [sharingPlugin]
      : ["./plugins/withShareExtensionDisplayName.cjs", sharingPlugin]),
    [
      "expo-notifications",
      {
        icon: variant.assets.androidNotificationIcon,
        color: variant.assets.androidNotificationColor,
        mode: APP_VARIANT === "development" ? "development" : "production",
      },
    ],
    "expo-web-browser",
    [
      "expo-quick-actions",
      {
        // Adaptive launcher-shortcut icon; referenced by resource name from
        // the shortcut items set in src/features/shortcuts.
        androidIcons: {
          shortcut_icon: {
            foregroundImage: variant.assets.androidAdaptiveForeground,
            backgroundColor: variant.assets.androidAdaptiveBackgroundColor,
            ...(variant.assets.androidAdaptiveBackgroundImage
              ? { backgroundImage: variant.assets.androidAdaptiveBackgroundImage }
              : {}),
          },
        },
      },
    ],
    [
      "expo-audio",
      {
        microphonePermission: "Allow T3 Agents to use your microphone for voice input.",
        recordAudioAndroid: false,
        enableBackgroundPlayback: false,
        enableBackgroundRecording: false,
      },
    ],
    [
      "expo-camera",
      {
        cameraPermission: "Allow T3 Agents to access your camera so you can scan pairing QR codes.",
        microphonePermission: false,
        barcodeScannerEnabled: true,
        recordAudioAndroid: false,
      },
    ],
    ["expo-image-picker", { photosPermission: false, microphonePermission: false }],
    [
      "expo-splash-screen",
      {
        image: variant.assets.splashIcon,
        resizeMode: "contain",
        backgroundColor: AGENTS_NAVY,
        imageWidth: 160,
        dark: {
          image: variant.assets.splashIcon,
          backgroundColor: AGENTS_NAVY,
        },
        android: {
          // Android 12+ masks the splash icon to a circle over the central two thirds of
          // its 288dp canvas, so the iOS export's corners get cut. A full-canvas image of
          // the composed adaptive layers puts the wordmark in the same frame the launcher
          // icon uses.
          image: variant.assets.androidSplashIcon,
          imageWidth: 288,
          dark: { image: variant.assets.androidSplashIcon },
        },
      },
    ],
    [
      "expo-build-properties",
      {
        android: {
          // Keep the supported floor explicit and covered by native notification tests.
          minSdkVersion: 24,
          // kotlinx-io uses Kotlin 2.3's return-value checker annotation, while
          // SDK 58 builds with Kotlin 2.2. It has no runtime behavior.
          //
          // WorkManager 2.9 keeps InputMerger classes but not their constructors,
          // and R8 full mode no longer keeps a default constructor implicitly.
          // Without it no work request can start, so the Glance session behind
          // the widget never renders and it stays on "Loading widget". WorkManager
          // 2.10 ships this rule itself; drop it once the resolved version gets there.
          extraProguardRules: [
            "-dontwarn kotlin.MustUseReturnValues",
            "-keep class * extends androidx.work.InputMerger { <init>(); }",
          ].join("\n"),
        },
        ios: {
          deploymentTarget: "18.0",
          // AppCheckCore 11.3+ includes Swift and needs module maps for these Objective-C dependencies.
          extraPods: [
            { name: "GoogleUtilities", modular_headers: true },
            { name: "RecaptchaInterop", modular_headers: true },
          ],
        },
      },
    ],
    "./plugins/withIosCocoaPodsUuidCache.cjs",
    // Only the accelerometer is used (device viewer shake). Compile out the
    // pedometer so iOS needs no motion purpose string.
    ["expo-sensors", { motionPermission: false }],
    // Must be listed BEFORE expo-widgets: same-type mods run last-registered-
    // first, so registering earlier makes this plugin's mods run AFTER
    // expo-widgets' — its dangerous mod wipes ios/ExpoWidgetsTarget/ (which
    // would delete the asset catalog) and its xcodeproj mod creates the widget
    // target (which must exist before the compile phase can be attached).
    ...(!isIosPersonalTeamBuild ? ["./plugins/withWidgetLogoAsset.cjs", widgetsPlugin] : []),
    "./plugins/withAndroidCleartextTraffic.cjs",
    "./plugins/withAndroidGradleHeap.cjs",
    "./plugins/withAndroidInputBackground.cjs",
    "./plugins/withAndroidModernPopupMenu.cjs",
    "./plugins/withAndroidModernAlertDialog.cjs",
    "./plugins/withAndroidPredictiveBackCompat.cjs",
    "./plugins/withAndroidTabletOrientation.cjs",
    ...(isIosPersonalTeamBuild ? ["./plugins/withoutIosPersonalTeamCapabilities.cjs"] : []),
  ],
  extra: {
    eas: {
      projectId: "263247b1-0330-46c5-ac6a-7efcba44c359",
    },
    appVariant: APP_VARIANT,
    personalClient: isPersonalClient,
    iosPersonalTeamBuild: isIosPersonalTeamBuild,
    relay: { url: null },
    clerk: { publishableKey: null, jwtTemplate: null },
    observability: {
      tracesUrl: repoEnv.EXPO_PUBLIC_OTLP_TRACES_URL ?? "https://api.axiom.co/v1/traces",
      tracesDataset: repoEnv.EXPO_PUBLIC_OTLP_TRACES_DATASET ?? null,
      tracesToken: repoEnv.EXPO_PUBLIC_OTLP_TRACES_TOKEN ?? null,
    },
  },
  owner: "jayleaton",
};

export default config;

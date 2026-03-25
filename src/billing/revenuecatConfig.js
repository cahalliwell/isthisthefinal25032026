import { Platform } from "react-native";

export const REVENUECAT_CONFIG = {
  apiKeys: {
    ios:
      process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY ||
      process.env.REVENUECAT_IOS_API_KEY ||
      process.env.REVENUECAT_API_KEY_IOS ||
      "",
    android:
      process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_KEY ||
      process.env.REVENUECAT_ANDROID_API_KEY ||
      process.env.REVENUECAT_API_KEY_ANDROID ||
      "",
  },
  entitlementIds: {
    premium: "Premium",
  },
  packageIds: {
    premium: "$rc_monthly",
  },
  productIds: {
    premium: "premium_monthly:monthly",
  },
  offeringId: "Default",
};

export const getRevenueCatApiKey = () => {
  const platformKey = Platform.select({
    ios: REVENUECAT_CONFIG.apiKeys.ios,
    android: REVENUECAT_CONFIG.apiKeys.android,
    default: REVENUECAT_CONFIG.apiKeys.android || REVENUECAT_CONFIG.apiKeys.ios,
  });
  return platformKey && platformKey.trim() ? platformKey.trim() : null;
};
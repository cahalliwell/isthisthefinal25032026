import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { REVENUECAT_CONFIG, getRevenueCatApiKey } from "./revenuecatConfig";
import {
  notifyPurchaseOutcome,
  resolveRevenueCatPackage,
  shouldTreatAsCancellation,
} from "./revenuecatHelpers";
import { getPurchases, getPurchasesLogLevel } from "./revenuecatModule";

export const defaultRevenueCatState = {
  ready: false,
  loading: false,
  activeAction: null,
  activeTargetId: null,
  offerings: null,
  packages: { premium: null },
  premiumPriceString: "",
  purchasePackage: async () => ({ success: false, error: new Error("Purchases unavailable") }),
  restorePurchases: async () => ({ success: false, error: new Error("Purchases unavailable") }),
  refreshOfferings: async () => null,
  premiumActive: false,
  activeEntitlementIds: [],
  customerInfo: null,
  lastError: null,
};

export const RevenueCatContext = createContext(defaultRevenueCatState);

export function useRevenueCat() {
  return useContext(RevenueCatContext);
}

export function usePremiumPurchaseFlow(successTitle, successMessage) {
  const { packages, purchasePackage } = useRevenueCat();
  return useCallback(async () => {
    const fallbackTarget = REVENUECAT_CONFIG.packageIds.premium || REVENUECAT_CONFIG.productIds.premium;
    const outcome = await purchasePackage(packages?.premium || fallbackTarget);
    notifyPurchaseOutcome(outcome, { successTitle, successMessage });
    return outcome;
  }, [packages?.premium, purchasePackage, successTitle, successMessage]);
}

export function useRevenueCatController(appUserID, authReady) {
  const [isConfigured, setConfigured] = useState(false);
  const [offerings, setOfferings] = useState(null);
  const [customerInfo, setCustomerInfo] = useState(null);
  const [lastError, setLastError] = useState(null);
  const [busyState, setBusyState] = useState({ busy: false, action: null, targetId: null });
  const configureKeyRef = useRef(null);
  const configuringRef = useRef(false);
  const currentUserRef = useRef(null);
  const identitySyncingRef = useRef(false);
  const revenueCatApiKey = useMemo(() => getRevenueCatApiKey(), []);
  const logPremiumOfferingsDebug = useCallback((sourceLabel, offeringsPayload) => {
    try {
      const allOfferings = offeringsPayload?.all || {};
      const currentOfferingIdentifier =
        offeringsPayload?.current?.identifier || offeringsPayload?.currentOfferingIdentifier || null;
      const availablePackageIds = Object.values(allOfferings).flatMap((offering) =>
        (offering?.availablePackages || []).map(
          (pkg) => pkg?.identifier || pkg?.packageIdentifier || pkg?.product?.identifier || "unknown"
        )
      );
      const currentPackages = offeringsPayload?.current?.availablePackages || [];
      const currentPackageIds = currentPackages.map(
        (pkg) => pkg?.identifier || pkg?.packageIdentifier || pkg?.product?.identifier || "unknown"
      );
      const currentPackagesDetailed = currentPackages.map((pkg) => ({
        packageIdentifier: pkg?.identifier || pkg?.packageIdentifier || null,
        productIdentifier: pkg?.product?.identifier || null,
        priceString: pkg?.product?.priceString || null,
      }));
      const mergedPackageIds = [...new Set([...currentPackageIds, ...availablePackageIds])];
      const hasRcMonthly = mergedPackageIds.includes(REVENUECAT_CONFIG.packageIds.premium);
      console.log("[RC DEBUG]", sourceLabel, {
        configured: isConfigured,
        offeringShape: {
          hasCurrent: Boolean(offeringsPayload?.current),
          allOfferingIds: Object.keys(allOfferings),
        },
        offeringsPayload,
        offeringsCurrentIdentifier: currentOfferingIdentifier,
        offeringsCurrentAvailablePackages: currentPackagesDetailed,
        availablePackageIds: mergedPackageIds,
        premiumPackageIdentifier: REVENUECAT_CONFIG.packageIds.premium,
        premiumPackageFound: hasRcMonthly,
      });
    } catch (debugError) {
      console.log("[RC DEBUG] offerings debug log error:", debugError?.message || debugError);
    }
  }, [isConfigured]);

  useEffect(() => {
    const Purchases = getPurchases();
    const PurchasesLogLevel = getPurchasesLogLevel();
   const configureAppUserID = authReady && appUserID ? appUserID : null;
   const configureKey = configureAppUserID ? `${revenueCatApiKey}:${configureAppUserID}` : null;

    console.log("[RC DEBUG] configure precheck", {
      sdkAvailable: Boolean(Purchases),
      publicSdkKeyPresent: Boolean(revenueCatApiKey),
      authReady,
      configureAppUserID,
    });
    if (!Purchases || !revenueCatApiKey || !authReady || !configureAppUserID || !configureKey) {
      return;
    }
    if (configureKeyRef.current === configureKey || configuringRef.current) {
      return;
    }
    configuringRef.current = true;
    let cancelled = false;

    const configure = async () => {
      try {
        if (Purchases.setLogLevel && PurchasesLogLevel?.WARN != null) {
          Purchases.setLogLevel(PurchasesLogLevel.WARN);
        }
        await Purchases.configure({
          apiKey: revenueCatApiKey,
          appUserID: configureAppUserID || undefined,
        }); // CHANGED: configure with authenticated appUserID immediately when available.
        if (cancelled) return;
        console.log("[RC DEBUG] configure success", { configureAppUserID });
        configureKeyRef.current = configureKey;
        currentUserRef.current = null;
        setConfigured(true);
        setLastError(null);
        try {
          const info = await Purchases.getCustomerInfo();
          
          console.log("[RC TEST] configure", {
          expectedUser: configureAppUserID,
          rcUser: info?.appUserID,
          original: info?.originalAppUserId,
          entitlements: Object.keys(info?.entitlements?.active || {}),
        });
          
          if (!cancelled) {
            setCustomerInfo(info);
          }
        } catch (infoError) {
          if (!cancelled) {
            setLastError(infoError);
          }
        }
        try {
          const nextOfferings = await Purchases.getOfferings();
          console.log("[RC DEBUG] Purchases.getOfferings result (configure)", nextOfferings);
          if (!cancelled) {
            setOfferings(nextOfferings);
            logPremiumOfferingsDebug("configure:getOfferings", nextOfferings);
          }
        } catch (offeringsError) {
          if (!cancelled) {
            setLastError(offeringsError);
          }
        }
      } catch (error) {
        console.log("RevenueCat configure error:", error?.message || error);
        if (!cancelled) {
          configureKeyRef.current = null;
          setConfigured(false);
          setLastError(error);
        }
      } finally {
        configuringRef.current = false;
      }
    };

    configure();

    const listener = Purchases.addCustomerInfoUpdateListener?.((info) => {
      setCustomerInfo(info);
    });

    return () => {
      cancelled = true;
      if (listener?.remove) {
        listener.remove();
      } else if (typeof listener === "function") {
        listener();
      }
    };
  }, [appUserID, authReady, revenueCatApiKey, logPremiumOfferingsDebug]);

  useEffect(() => {
    const Purchases = getPurchases();
    if (!Purchases || !isConfigured || !authReady || configuringRef.current || identitySyncingRef.current) {
      return;
    }
    if (appUserID && currentUserRef.current === appUserID) {
      return;
    }
    if (!appUserID && !currentUserRef.current) {
      return;
    }

    let cancelled = false;

    const syncIdentity = async () => {
      identitySyncingRef.current = true;
      try {
        if (appUserID) {
          const currentInfo = customerInfo || (await Purchases.getCustomerInfo()); // CHANGED: check the current RC user before calling logIn again.
          if (cancelled) return;
          const currentRevenueCatUserID = currentInfo?.appUserID || currentInfo?.originalAppUserId || null;
          if (currentRevenueCatUserID === appUserID) {
            currentUserRef.current = appUserID;
            setCustomerInfo(currentInfo);
          } else {
            const result = await Purchases.logIn(appUserID);
            if (cancelled) return;
            currentUserRef.current = appUserID;
            const info = result?.customerInfo || result;
            if (info) {
              setCustomerInfo(info);
            }
          }
        } else {
          const info = await Purchases.logOut();
          if (cancelled) return;
          currentUserRef.current = null;
          setCustomerInfo(info);
        }
        const refreshedInfo = await Purchases.getCustomerInfo(); // CHANGED: always refresh entitlement state after identity changes.
        if (!cancelled) {
          setCustomerInfo(refreshedInfo);
          setLastError(null);
        }
      } catch (error) {
        console.log("RevenueCat identity sync error:", error?.message || error);
        if (!cancelled) {
          setLastError(error);
        }
      } finally {
        identitySyncingRef.current = false;
      }
    };

    syncIdentity();

    return () => {
      cancelled = true;
    };
}, [appUserID, authReady, isConfigured]);

  useEffect(() => {
    const Purchases = getPurchases();
    if (!Purchases || !isConfigured) {
      return;
    }
    if (offerings) {
      return;
    }
    let cancelled = false;

    const loadOfferings = async () => {
      try {
        const nextOfferings = await Purchases.getOfferings();
        console.log("[RC DEBUG] Purchases.getOfferings result (loadOfferings)", nextOfferings);
        if (!cancelled) {
          setOfferings(nextOfferings);
          logPremiumOfferingsDebug("loadOfferings", nextOfferings);
        }
      } catch (error) {
        if (!cancelled) {
          setLastError(error);
        }
      }
    };

    loadOfferings();

    return () => {
      cancelled = true;
    };
  }, [isConfigured, offerings, logPremiumOfferingsDebug]);

  useEffect(() => {
    if (!customerInfo || !appUserID) return;
    const normalizedAppUser = customerInfo?.appUserID || customerInfo?.originalAppUserId;
    if (normalizedAppUser && normalizedAppUser !== appUserID) {
      console.warn(
        "RevenueCat alias mismatch detected",
        normalizedAppUser,
        "expected",
        appUserID
      );
    }
  }, [customerInfo, appUserID]);

  const refreshOfferings = useCallback(async () => {
    const Purchases = getPurchases();
    if (!Purchases || !isConfigured) {
      return null;
    }
    try {
      const nextOfferings = await Purchases.getOfferings();
      console.log("[RC DEBUG] Purchases.getOfferings result (refreshOfferings)", nextOfferings);
      setOfferings(nextOfferings);
      setLastError(null);
      return nextOfferings;
    } catch (error) {
      console.log("RevenueCat offerings error:", error?.message || error);
      setLastError(error);
      throw error;
    }
  }, [isConfigured]);

  const purchasePackage = useCallback(
    async (target) => {
      const Purchases = getPurchases();

      console.log("[RC TEST] purchase:start", {
      appUserID,
      authReady,
      isConfigured,
    });

      if (!Purchases || !isConfigured || !authReady || !appUserID) { // CHANGED: block purchases until SDK, auth, and appUserID are all ready.
        const error = new Error("Purchases not ready. Please try again shortly.");
        const notReadyReason = !Purchases
          ? "sdk_unavailable"
          : !isConfigured
          ? "sdk_not_configured"
          : !authReady
          ? "auth_not_ready"
          : !appUserID
          ? "missing_app_user_id"
          : "unknown_not_ready";
        console.log("[RC DEBUG] premium purchase blocked: purchases not ready", {
          notReadyReason,
          sdkAvailable: Boolean(Purchases),
          isConfigured,
          publicSdkKeyPresent: Boolean(revenueCatApiKey),
          activeAction: busyState.action,
          hasOfferings: Boolean(offerings),
          authReady,
          appUserID,
        });
        setLastError(error);
        return { success: false, error };
      }
      const fallbackTarget =
        typeof target === "string"
          ? target
          : REVENUECAT_CONFIG.packageIds.premium || REVENUECAT_CONFIG.productIds.premium;
      const resolved =
        resolveRevenueCatPackage(target, offerings) ||
        resolveRevenueCatPackage(fallbackTarget, offerings) ||
        resolveRevenueCatPackage(REVENUECAT_CONFIG.packageIds.premium, offerings) ||
        resolveRevenueCatPackage(REVENUECAT_CONFIG.productIds.premium, offerings) ||
        resolveRevenueCatPackage(target, { current: null, all: {} });
      logPremiumOfferingsDebug("purchasePackage", offerings);
      console.log("[RC DEBUG] premium package resolution", {
        target,
        fallbackTarget,
        premiumPackageIdentifier: REVENUECAT_CONFIG.packageIds.premium,
        premiumPackageFound: Boolean(resolved),
        resolvedIdentifier:
          resolved?.identifier || resolved?.packageIdentifier || resolved?.product?.identifier || null,
      });
      const targetId =
        resolved?.identifier ||
        resolved?.packageIdentifier ||
        resolved?.product?.identifier ||
        (typeof target === "string" ? target : fallbackTarget);
      if (!resolved) {
        const error = new Error("Purchase options are unavailable. Please refresh and try again.");
        setLastError(error);
        return { success: false, error };
      }
      setBusyState({ busy: true, action: "purchase", targetId });
      try {
        const result = await Purchases.purchasePackage(resolved);
        const info = result?.customerInfo || result;
        const refreshedInfo = await Purchases.getCustomerInfo(); // CHANGED: re-fetch customer info so success depends on fresh premium entitlement data.
        const activeInfo = refreshedInfo || info;

        console.log("[RC TEST] purchase:result", {
        rcUser: activeInfo?.appUserID,
        entitlements: Object.keys(activeInfo?.entitlements?.active || {}),
        premiumActive: Boolean(
          activeInfo?.entitlements?.active?.[REVENUECAT_CONFIG.entitlementIds.premium]
        ),
      });

        if (activeInfo) {
          setCustomerInfo(activeInfo);
        }
        const premiumEntitlement = activeInfo?.entitlements?.active?.[REVENUECAT_CONFIG.entitlementIds.premium];
        if (!premiumEntitlement) {
          const error = new Error("Purchase completed, but premium entitlement is not active yet. Please try restore or reopen the paywall."); // CHANGED: do not report false success before the premium entitlement is active.
          setLastError(error);
          return { success: false, error, result };
        }
        setLastError(null);
        return { success: true, result };
      } catch (error) {
        if (shouldTreatAsCancellation(error)) {
          return { success: false, cancelled: true };
        }
        console.log("RevenueCat purchase error:", error?.message || error);
        setLastError(error);
        return { success: false, error };
      } finally {
        setBusyState({ busy: false, action: null, targetId: null });
      }
    },
    [appUserID, authReady, isConfigured, offerings, revenueCatApiKey, busyState.action, logPremiumOfferingsDebug]
  );

  const restorePurchases = useCallback(async () => {
    const Purchases = getPurchases();
    if (!Purchases || !isConfigured) {
      const error = new Error("Restore unavailable. Please try again later.");
      setLastError(error);
      return { success: false, error };
    }
    setBusyState({ busy: true, action: "restore", targetId: null });
    try {
      const info = await Purchases.restorePurchases();
      const refreshedInfo = await Purchases.getCustomerInfo(); // CHANGED: refresh customer info after restore so UI uses the latest entitlements.
      const activeInfo = refreshedInfo || info;
      if (activeInfo) {
        setCustomerInfo(activeInfo);
      }
      setLastError(null);
      return { success: true, result: activeInfo };
    } catch (error) {
      console.log("RevenueCat restore error:", error?.message || error);
      setLastError(error);
      return { success: false, error };
    } finally {
      setBusyState({ busy: false, action: null, targetId: null });
    }
  }, [isConfigured]);

  const activeEntitlementIds = useMemo(() => {
    const active = customerInfo?.entitlements?.active || {};
    return Object.keys(active);
  }, [customerInfo?.entitlements?.active]);

  const activeEntitlements = useMemo(() => new Set(activeEntitlementIds), [activeEntitlementIds]);

  const premiumPackage = useMemo(
    () =>
      resolveRevenueCatPackage(REVENUECAT_CONFIG.packageIds.premium, offerings) ||
      resolveRevenueCatPackage(REVENUECAT_CONFIG.productIds.premium, offerings),
    [offerings]
  );
  const contextValue = useMemo(
    () => ({
      ready: isConfigured,
      loading: busyState.busy,
      activeAction: busyState.action,
      activeTargetId: busyState.targetId,
      offerings,
      packages: { premium: premiumPackage },
      premiumPriceString: premiumPackage?.product?.priceString || "",
      purchasePackage,
      restorePurchases,
      refreshOfferings,
      premiumActive: activeEntitlements.has(REVENUECAT_CONFIG.entitlementIds.premium),
      activeEntitlementIds,
      customerInfo,
      lastError,
    }),
    [
      isConfigured,
      busyState.busy,
      busyState.action,
      busyState.targetId,
      offerings,
      premiumPackage,
      purchasePackage,
      restorePurchases,
      refreshOfferings,
      activeEntitlements,
      activeEntitlementIds,
      customerInfo,
      lastError,
    ]
  );

  return contextValue;
}
// @ts-nocheck
export {};

function createSharedObjectIpcHandlers(deps) {
  const broadcast = deps.broadcast;
  const desktopState = deps.desktopState;
  const SHARED_OBJECT_SNAPSHOT = deps.sharedObjectSnapshot;
  const STATSIG_DEFAULT_FEATURES_CONFIG = deps.statsigDefaultFeaturesConfig;

  function getSnapshot() {
    return desktopState.sharedObjectSnapshotObject();
  }

  function setSharedObject(payload) {
    if (payload && typeof payload === "object" && payload.key) {
      const value = desktopState.normalizeSharedObjectSnapshotValue(payload.key, payload.value);
      SHARED_OBJECT_SNAPSHOT.set(payload.key, value);
      if (typeof broadcast === "function") {
        broadcast({ channel: "shared-object-updated", payload: { ...payload, value } });
      }
    }
    return true;
  }

  function subscribeSharedObject(payload) {
    if (payload && typeof payload === "object" && payload.key) {
      if (payload.key === STATSIG_DEFAULT_FEATURES_CONFIG || SHARED_OBJECT_SNAPSHOT.has(payload.key)) {
        const value = desktopState.normalizeSharedObjectSnapshotValue(payload.key, SHARED_OBJECT_SNAPSHOT.get(payload.key));
        SHARED_OBJECT_SNAPSHOT.set(payload.key, value);
        if (typeof broadcast === "function") {
          broadcast({ channel: "shared-object-updated", payload: { key: payload.key, value } });
        }
      }
    }
    return true;
  }

  return {
    getSnapshot,
    setSharedObject,
    subscribeSharedObject,
  };
}

module.exports = {
  createSharedObjectIpcHandlers,
};

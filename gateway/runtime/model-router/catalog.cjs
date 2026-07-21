const { AUTO_MODEL_ID } = require("./constants.cjs");
const { modelIdentifier } = require("./resolver.cjs");

function createModelCatalog() {
  const modelsByKey = new Map();
  let complete = false;
  let updatedAt = 0;

  function addModels(models) {
    for (const model of Array.isArray(models) ? models : []) {
      const key = modelIdentifier(model);
      if (!key || key.toLowerCase() === AUTO_MODEL_ID) continue;
      modelsByKey.set(key, JSON.parse(JSON.stringify(model)));
    }
    updatedAt = Date.now();
  }

  function observePage({ cursor, result }) {
    if (!result || !Array.isArray(result.data)) return;
    if (!cursor) modelsByKey.clear();
    addModels(result.data);
    complete = result.nextCursor == null;
  }

  return {
    addModels,
    clear() {
      modelsByKey.clear();
      complete = false;
      updatedAt = Date.now();
    },
    isComplete() {
      return complete;
    },
    observePage,
    snapshot() {
      return {
        complete,
        updatedAt,
        models: Array.from(modelsByKey.values()),
      };
    },
    models() {
      return Array.from(modelsByKey.values()).map((model) => JSON.parse(JSON.stringify(model)));
    },
  };
}

module.exports = { createModelCatalog };

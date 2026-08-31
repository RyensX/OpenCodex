const {
  ADAPTER_DEFINITIONS: TYPED_ADAPTER_DEFINITIONS,
  POINT_DEFINITIONS: TYPED_POINT_DEFINITIONS,
  POINT_GROUP_DEFINITIONS: TYPED_POINT_GROUP_DEFINITIONS,
} = require("../../dist/modification/catalog.js");

function adapterChain(adapter, visiting = new Set()) {
  if (visiting.has(adapter)) throw new Error(`Compatibility adapter cycle: ${adapter.id}`);
  const next = new Set(visiting);
  next.add(adapter);
  return [adapter, ...adapter.dependencies.flatMap((dependency) => adapterChain(dependency, next))];
}

const POINT_GROUP_DEFINITIONS = Object.freeze(
  TYPED_POINT_GROUP_DEFINITIONS.map((group) => Object.freeze({
    id: group.id,
    name: group.name,
    description: group.description,
    order: group.order,
  }))
);

const ADAPTER_DEFINITIONS = Object.freeze(
  TYPED_ADAPTER_DEFINITIONS.map((adapter) => Object.freeze({
    id: adapter.id,
    name: adapter.name,
    description: adapter.description,
    kind: adapter.kind,
    dependencies: Object.freeze(adapter.dependencies.map((dependency) => dependency.id)),
  }))
);

const POINT_DEFINITIONS = Object.freeze(
  TYPED_POINT_DEFINITIONS.map((point) => {
    const directAdapters = point.contributions.map((contribution) => contribution.adapter);
    const chain = directAdapters.flatMap((adapter) => adapterChain(adapter));
    return Object.freeze({
      id: point.id,
      description: point.description,
      owner: point.owner,
      groupId: point.group.id,
      directAdapterIds: Object.freeze([...new Set(directAdapters.map((adapter) => adapter.id))]),
      adapterChainIds: Object.freeze([...new Set(chain.map((adapter) => adapter.id))]),
    });
  })
);

function registerCompatibilityCatalog(registry) {
  registry.registerGroups(POINT_GROUP_DEFINITIONS);
  registry.registerAdapterTypes(ADAPTER_DEFINITIONS);
  registry.registerPoints(POINT_DEFINITIONS);
  return registry;
}

module.exports = {
  ADAPTER_DEFINITIONS,
  POINT_DEFINITIONS,
  POINT_GROUP_DEFINITIONS,
  registerCompatibilityCatalog,
};

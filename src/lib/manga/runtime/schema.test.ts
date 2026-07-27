import { describe, expect, test } from "vitest";

import {
  INTROSPECTION_OPERATION,
  canonicalSchemaJson,
  canonicalSchemaSha256,
  evaluateRuntimeContract,
} from "./schema";
import type { RuntimeContract } from "./types";

function namedType(name: string) {
  return { kind: "OBJECT", name, ofType: null };
}

function field(name: string) {
  return {
    name,
    isDeprecated: false,
    args: [],
    type: namedType("String"),
  };
}

function introspectionData(order: "forward" | "reverse" = "forward") {
  const queryFields = [field("sources"), field("extensions")];
  const sourceFields = [field("displayName"), field("id"), field("preferences")];
  const types = [
    {
      kind: "OBJECT",
      name: "Query",
      fields: order === "forward" ? queryFields : [...queryFields].reverse(),
      inputFields: null,
      enumValues: null,
    },
    {
      kind: "OBJECT",
      name: "Mutation",
      fields: [field("updateExtension")],
      inputFields: null,
      enumValues: null,
    },
    {
      kind: "OBJECT",
      name: "SourceType",
      fields: order === "forward" ? sourceFields : [...sourceFields].reverse(),
      inputFields: null,
      enumValues: null,
    },
  ];
  return {
    __schema: {
      queryType: { name: "Query" },
      mutationType: { name: "Mutation" },
      types: order === "forward" ? types : [...types].reverse(),
    },
  };
}

const contract: RuntimeContract = {
  requiredQueries: ["sources", "extensions"],
  requiredMutations: ["updateExtension"],
  requiredFields: {
    SourceType: ["id", "displayName"],
  },
  optionalCapabilities: ["sourcePreferences", "extensionStoresV2"],
};

describe("GraphQL runtime contract", () => {
  test("canonicalizes order-dependent introspection output", async () => {
    const forward = INTROSPECTION_OPERATION.decode(introspectionData("forward"));
    const reverse = INTROSPECTION_OPERATION.decode(introspectionData("reverse"));

    expect(canonicalSchemaJson(forward)).toBe(canonicalSchemaJson(reverse));
    await expect(canonicalSchemaSha256(forward)).resolves.toBe(
      await canonicalSchemaSha256(reverse),
    );
  });

  test("uses semantic fields for compatibility and reports optional capabilities separately", () => {
    const schema = INTROSPECTION_OPERATION.decode(introspectionData());
    const report = evaluateRuntimeContract(schema, contract);

    expect(report.compatible).toBe(true);
    expect(report.capabilities.sourcePreferences).toBe(true);
    expect(report.capabilities.extensionStoresV2).toBe(false);
    expect(report.capabilities.supported).toEqual(["sourcePreferences"]);
  });

  test("reports missing operations and fields without relying on the schema hash", () => {
    const schema = INTROSPECTION_OPERATION.decode(introspectionData());
    const report = evaluateRuntimeContract(schema, {
      ...contract,
      requiredQueries: [...contract.requiredQueries, "extensionStores"],
      requiredFields: {
        ...contract.requiredFields,
        SourceType: ["id", "homeUrl"],
      },
    });

    expect(report.compatible).toBe(false);
    expect(report.missingQueries).toEqual(["extensionStores"]);
    expect(report.missingFields).toEqual({ SourceType: ["homeUrl"] });
  });
});

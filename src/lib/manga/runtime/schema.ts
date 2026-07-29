import { array, field, nullableString, record, string } from "./codec";
import type {
  RuntimeCapabilities,
  RuntimeCapability,
  RuntimeContract,
  RuntimeContractReport,
} from "./types";
import type { GraphQLOperation } from "./transport";

interface SchemaField {
  name: string;
  args: readonly SchemaInputValue[];
  type: SchemaTypeRef;
  isDeprecated: boolean;
}

interface SchemaInputValue {
  name: string;
  type: SchemaTypeRef;
  defaultValue: string | null;
}

interface SchemaTypeRef {
  kind: string;
  name: string | null;
  ofType: SchemaTypeRef | null;
}

interface SchemaType {
  kind: string;
  name: string;
  fields: readonly SchemaField[];
  inputFields: readonly SchemaInputValue[];
  enumValues: readonly string[];
}

export interface CanonicalGraphQLSchema {
  queryType: string;
  mutationType: string | null;
  types: readonly SchemaType[];
}

const TYPE_REF_SELECTION = `
  kind
  name
  ofType {
    kind
    name
    ofType {
      kind
      name
      ofType {
        kind
        name
        ofType {
          kind
          name
        }
      }
    }
  }
`;

export const INTROSPECTION_OPERATION: GraphQLOperation<
  Readonly<Record<string, never>>,
  CanonicalGraphQLSchema
> = {
  name: "AethonRuntimeContract",
  kind: "query",
  document: `
    query AethonRuntimeContract {
      __schema {
        queryType { name }
        mutationType { name }
        types {
          kind
          name
          fields(includeDeprecated: true) {
            name
            isDeprecated
            args {
              name
              defaultValue
              type { ${TYPE_REF_SELECTION} }
            }
            type { ${TYPE_REF_SELECTION} }
          }
          inputFields {
            name
            defaultValue
            type { ${TYPE_REF_SELECTION} }
          }
          enumValues(includeDeprecated: true) {
            name
          }
        }
      }
    }
  `,
  decode: decodeIntrospection,
};

const CAPABILITY_REQUIREMENTS: Readonly<
  Record<RuntimeCapability, Pick<RuntimeContract, "requiredQueries" | "requiredMutations" | "requiredFields">>
> = {
  extensionStoresV2: {
    requiredQueries: ["extensionStores"],
    requiredMutations: ["addExtensionStore", "removeExtensionStore"],
    requiredFields: {
      ExtensionStoreType: ["indexUrl", "name", "signingKey"],
    },
  },
  directJarInstall: {
    requiredQueries: [],
    requiredMutations: ["installExternalExtension"],
    requiredFields: {
      ExtensionType: ["jarUrl"],
    },
  },
  extensionApi16: {
    requiredQueries: [],
    requiredMutations: [],
    requiredFields: {
      ExtensionType: ["contentWarning", "versionCodeLong"],
    },
  },
  sourcePreferences: {
    requiredQueries: [],
    requiredMutations: [],
    requiredFields: {
      SourceType: ["preferences"],
    },
  },
};

function decodeTypeRef(value: unknown, path: string): SchemaTypeRef {
  const raw = record(value, path);
  const nested = raw.ofType === null || raw.ofType === undefined
    ? null
    : decodeTypeRef(raw.ofType, `${path}.ofType`);
  return {
    kind: string(field(raw, "kind", path), `${path}.kind`),
    name: nullableString(field(raw, "name", path), `${path}.name`),
    ofType: nested,
  };
}

function decodeInputValue(value: unknown, path: string): SchemaInputValue {
  const raw = record(value, path);
  return {
    name: string(field(raw, "name", path), `${path}.name`),
    defaultValue: nullableString(field(raw, "defaultValue", path), `${path}.defaultValue`),
    type: decodeTypeRef(field(raw, "type", path), `${path}.type`),
  };
}

function decodeIntrospection(value: unknown): CanonicalGraphQLSchema {
  const data = record(value, "data");
  const rawSchema = record(field(data, "__schema", "data"), "data.__schema");
  const queryType = record(field(rawSchema, "queryType", "data.__schema"), "data.__schema.queryType");
  const rawMutation = rawSchema.mutationType;
  const mutationType = rawMutation === null || rawMutation === undefined
    ? null
    : string(
        field(record(rawMutation, "data.__schema.mutationType"), "name", "data.__schema.mutationType"),
        "data.__schema.mutationType.name",
      );

  const types = array(field(rawSchema, "types", "data.__schema"), "data.__schema.types").map(
    (value, typeIndex): SchemaType => {
      const path = `data.__schema.types[${typeIndex}]`;
      const raw = record(value, path);
      const rawFields = raw.fields === null || raw.fields === undefined ? [] : array(raw.fields, `${path}.fields`);
      const rawInputs = raw.inputFields === null || raw.inputFields === undefined
        ? []
        : array(raw.inputFields, `${path}.inputFields`);
      const rawEnums = raw.enumValues === null || raw.enumValues === undefined
        ? []
        : array(raw.enumValues, `${path}.enumValues`);
      return {
        kind: string(field(raw, "kind", path), `${path}.kind`),
        name: string(field(raw, "name", path), `${path}.name`),
        fields: rawFields.map((fieldValue, fieldIndex) => {
          const fieldPath = `${path}.fields[${fieldIndex}]`;
          const rawField = record(fieldValue, fieldPath);
          return {
            name: string(field(rawField, "name", fieldPath), `${fieldPath}.name`),
            isDeprecated: rawField.isDeprecated === true,
            args: array(field(rawField, "args", fieldPath), `${fieldPath}.args`).map(
              (arg, argIndex) => decodeInputValue(arg, `${fieldPath}.args[${argIndex}]`),
            ),
            type: decodeTypeRef(field(rawField, "type", fieldPath), `${fieldPath}.type`),
          };
        }),
        inputFields: rawInputs.map((input, inputIndex) =>
          decodeInputValue(input, `${path}.inputFields[${inputIndex}]`)
        ),
        enumValues: rawEnums.map((enumValue, enumIndex) => {
          const enumPath = `${path}.enumValues[${enumIndex}]`;
          const rawEnum = record(enumValue, enumPath);
          return string(field(rawEnum, "name", enumPath), `${enumPath}.name`);
        }),
      };
    },
  );

  return canonicalizeSchema({
    queryType: string(field(queryType, "name", "data.__schema.queryType"), "data.__schema.queryType.name"),
    mutationType,
    types,
  });
}

function canonicalTypeRef(ref: SchemaTypeRef): SchemaTypeRef {
  return {
    kind: ref.kind,
    name: ref.name,
    ofType: ref.ofType ? canonicalTypeRef(ref.ofType) : null,
  };
}

export function canonicalizeSchema(schema: CanonicalGraphQLSchema): CanonicalGraphQLSchema {
  return {
    queryType: schema.queryType,
    mutationType: schema.mutationType,
    types: [...schema.types]
      .map((type) => ({
        kind: type.kind,
        name: type.name,
        fields: [...type.fields]
          .map((schemaField) => ({
            name: schemaField.name,
            args: [...schemaField.args]
              .map((arg) => ({
                name: arg.name,
                type: canonicalTypeRef(arg.type),
                defaultValue: arg.defaultValue,
              }))
              .sort((left, right) => left.name.localeCompare(right.name)),
            type: canonicalTypeRef(schemaField.type),
            isDeprecated: schemaField.isDeprecated,
          }))
          .sort((left, right) => left.name.localeCompare(right.name)),
        inputFields: [...type.inputFields]
          .map((input) => ({
            name: input.name,
            type: canonicalTypeRef(input.type),
            defaultValue: input.defaultValue,
          }))
          .sort((left, right) => left.name.localeCompare(right.name)),
        enumValues: [...type.enumValues].sort((left, right) => left.localeCompare(right)),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

export function canonicalSchemaJson(schema: CanonicalGraphQLSchema): string {
  return JSON.stringify(canonicalizeSchema(schema));
}

export async function canonicalSchemaSha256(schema: CanonicalGraphQLSchema): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalSchemaJson(schema));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function canonicalRuntimeCapabilitiesJson(capabilities: RuntimeCapabilities): string {
  return JSON.stringify({
    directJarInstall: capabilities.directJarInstall,
    extensionApi16: capabilities.extensionApi16,
    extensionStoresV2: capabilities.extensionStoresV2,
    sourcePreferences: capabilities.sourcePreferences,
    supported: [...capabilities.supported].sort((left, right) => left.localeCompare(right)),
  });
}

export async function runtimeCapabilitiesSha256(capabilities: RuntimeCapabilities): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalRuntimeCapabilitiesJson(capabilities));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function evaluateRequirements(
  schema: CanonicalGraphQLSchema,
  requirements: Pick<RuntimeContract, "requiredQueries" | "requiredMutations" | "requiredFields">,
): Pick<RuntimeContractReport, "missingQueries" | "missingMutations" | "missingFields"> {
  const typeMap = new Map(schema.types.map((type) => [type.name, type]));
  const queries = new Set(typeMap.get(schema.queryType)?.fields.map((item) => item.name) ?? []);
  const mutations = new Set(
    schema.mutationType ? typeMap.get(schema.mutationType)?.fields.map((item) => item.name) ?? [] : [],
  );
  const missingFields: Record<string, readonly string[]> = {};

  for (const [typeName, fields] of Object.entries(requirements.requiredFields)) {
    const available = new Set(typeMap.get(typeName)?.fields.map((item) => item.name) ?? []);
    const missing = fields.filter((name) => !available.has(name));
    if (missing.length > 0) missingFields[typeName] = missing;
  }

  return {
    missingQueries: requirements.requiredQueries.filter((name) => !queries.has(name)),
    missingMutations: requirements.requiredMutations.filter((name) => !mutations.has(name)),
    missingFields,
  };
}

export function evaluateRuntimeContract(
  schema: CanonicalGraphQLSchema,
  contract: RuntimeContract,
): RuntimeContractReport {
  const missing = evaluateRequirements(schema, contract);
  const supported = contract.optionalCapabilities.filter((capability) => {
    const result = evaluateRequirements(schema, CAPABILITY_REQUIREMENTS[capability]);
    return result.missingQueries.length === 0
      && result.missingMutations.length === 0
      && Object.keys(result.missingFields).length === 0;
  });
  const capabilitySet = new Set(supported);
  const capabilities: RuntimeCapabilities = {
    extensionStoresV2: capabilitySet.has("extensionStoresV2"),
    directJarInstall: capabilitySet.has("directJarInstall"),
    extensionApi16: capabilitySet.has("extensionApi16"),
    sourcePreferences: capabilitySet.has("sourcePreferences"),
    supported,
  };

  return {
    compatible: missing.missingQueries.length === 0
      && missing.missingMutations.length === 0
      && Object.keys(missing.missingFields).length === 0,
    ...missing,
    capabilities,
  };
}

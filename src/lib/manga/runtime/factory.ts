import { SuwayomiAdapter } from "./adapter";
import {
  CompatibilityProfileV21,
  CompatibilityProfileV23,
  type CompatibilityProfile,
} from "./compatibility";
import { SourceRuntimeError } from "./errors";
import {
  INTROSPECTION_OPERATION,
  evaluateRuntimeContract,
  type CanonicalGraphQLSchema,
} from "./schema";
import type { SourceRuntime } from "./types";
import type { GraphQLTransport } from "./transport";

interface CompatibilityDetection {
  profile: CompatibilityProfile;
  schema: CanonicalGraphQLSchema;
}

async function inspectCompatibility(
  transport: GraphQLTransport,
): Promise<CompatibilityDetection> {
  const schema = await transport.execute(INTROSPECTION_OPERATION, {});
  const profiles: readonly CompatibilityProfile[] = [
    new CompatibilityProfileV23(),
    new CompatibilityProfileV21(),
  ];

  for (const profile of profiles) {
    if (evaluateRuntimeContract(schema, profile.contract).compatible) {
      return { profile, schema };
    }
  }

  throw new SourceRuntimeError(
    "RUNTIME_INCOMPATIBLE",
    "Suwayomi does not satisfy a supported Aethon runtime contract.",
  );
}

export async function detectCompatibilityProfile(
  transport: GraphQLTransport,
): Promise<CompatibilityProfile> {
  return (await inspectCompatibility(transport)).profile;
}

export async function createSuwayomiSourceRuntime(
  transport: GraphQLTransport,
): Promise<SourceRuntime> {
  const { profile, schema } = await inspectCompatibility(transport);
  return new SuwayomiAdapter(transport, profile, schema);
}

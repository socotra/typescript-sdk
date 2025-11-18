// zod-json-schema-compat.ts
// ----------------------------------------------------
// JSON Schema conversion for both Zod v3 and Zod v4 (Mini)
// v3 uses your vendored converter; v4 uses Mini's toJSONSchema
// ----------------------------------------------------

import type * as z3 from 'zod/v3';
import type * as z4c from 'zod/v4/core';

import * as z4mini from 'zod/v4-mini';

import { AnyObjectSchema, isZ4Schema } from './zod-compat.js';
import { zodToJsonSchema } from 'zod-to-json-schema';

type JsonSchema = Record<string, unknown>;

// Options accepted by call sites; we map them appropriately
export type CommonOpts = {
    strictUnions?: boolean;
    pipeStrategy?: 'input' | 'output';
    target?: 'jsonSchema7' | 'draft-7' | 'jsonSchema2019-09' | 'draft-2020-12';
};

function mapMiniTarget(t: CommonOpts['target'] | undefined): 'draft-7' | 'draft-2020-12' {
    if (!t) return 'draft-7';
    if (t === 'jsonSchema7' || t === 'draft-7') return 'draft-7';
    if (t === 'jsonSchema2019-09' || t === 'draft-2020-12') return 'draft-2020-12';
    return 'draft-7'; // fallback
}

export function toJsonSchemaCompat(schema: AnyObjectSchema, opts?: CommonOpts): JsonSchema {
    if (isZ4Schema(schema)) {
        // v4 branch — use Mini's built-in toJSONSchema
        return z4mini.toJSONSchema(schema as z4c.$ZodType, {
            target: mapMiniTarget(opts?.target),
            io: opts?.pipeStrategy ?? 'input'
        }) as JsonSchema;
    }

    // v3 branch — use vendored converter
    return zodToJsonSchema(schema as z3.ZodTypeAny, {
        strictUnions: opts?.strictUnions ?? true,
        pipeStrategy: opts?.pipeStrategy ?? 'input'
    }) as JsonSchema;
}

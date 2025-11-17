# Zod v4 Compatibility Approach

This document outlines the comprehensive approach taken to make the MCP TypeScript SDK compatible with both Zod v3 and Zod v4, allowing users to use either version seamlessly.

## Overview

The primary goal was to support both Zod v3 (`^3.25`) and Zod v4 (`^4.0`) without breaking existing code. This required:

1. **Unified type system** that accepts both v3 and v4 schemas
2. **Runtime detection** to determine which Zod version is being used
3. **Compatibility layer** for operations that differ between versions
4. **Vendored dependencies** for v3-specific functionality
5. **Symbol-based metadata** instead of class inheritance for extensibility
6. **Comprehensive test coverage** for both versions

## Key Design Decisions

### 1. Dual Import Strategy

Zod v4 introduced subpath exports (`zod/v3`, `zod/v4/core`, `zod/v4-mini`) that allow importing specific versions. We leverage this to:

- Import types from both versions: `import type * as z3 from 'zod/v3'` and `import type * as z4 from 'zod/v4/core'`
- Import runtime implementations: `import * as z3rt from 'zod/v3'` and `import * as z4mini from 'zod/v4-mini'`
- Use v4 Mini as the default for new schemas (smaller bundle size)

### 2. No Version Mixing

We enforce that within a single schema shape (e.g., an object's properties), all schemas must be from the same version. Mixed versions throw an error at runtime.

### 3. Backward Compatibility First

The SDK maintains full backward compatibility with Zod v3 while adding v4 support. Existing code using v3 continues to work without changes.

## Core Compatibility Files

### `src/server/zod-compat.ts`

This is the **foundation** of the compatibility layer, providing unified types and runtime helpers.

#### Unified Types

```typescript
export type AnySchema = z3.ZodTypeAny | z4.$ZodType;
export type AnyObjectSchema = z3.AnyZodObject | z4.$ZodObject;
export type ZodRawShapeCompat = Record<string, AnySchema>;
```

These types accept schemas from either version, allowing the rest of the codebase to work with both.

#### Type Inference Helpers

```typescript
export type SchemaOutput<S> = S extends z3.ZodTypeAny ? z3.infer<S> : S extends z4.$ZodType ? z4.output<S> : never;

export type SchemaInput<S> = S extends z3.ZodTypeAny ? z3.input<S> : S extends z4.$ZodType ? z4.input<S> : never;
```

These conditional types correctly infer input/output types based on which version is being used.

#### Runtime Detection

```typescript
export function isZ4Schema(s: AnySchema): s is z4.$ZodType {
    // Present on Zod 4 (Classic & Mini) schemas; absent on Zod 3
    return !!(s as any)?._zod;
}
```

Zod v4 schemas have a `_zod` property that v3 schemas lack. This is the key to runtime version detection.

#### Schema Construction

```typescript
export function objectFromShape(shape: ZodRawShapeCompat): AnyObjectSchema {
    const values = Object.values(shape);
    if (values.length === 0) return z4mini.object({}); // default to v4 Mini

    const allV4 = values.every(isZ4Schema);
    const allV3 = values.every(s => !isZ4Schema(s));

    if (allV4) return z4mini.object(shape as Record<string, z4.$ZodType>);
    if (allV3) return z3rt.object(shape as Record<string, z3.ZodTypeAny>);

    throw new Error('Mixed Zod versions detected in object shape.');
}
```

This function:

- Detects which version all schemas in a shape belong to
- Constructs the appropriate object schema using the correct version's API
- Throws if versions are mixed (enforcing our "no mixing" rule)

#### Unified Parsing

```typescript
export function safeParse<S extends AnySchema>(schema: S, data: unknown): { success: true; data: SchemaOutput<S> } | { success: false; error: unknown } {
    if (isZ4Schema(schema)) {
        // Mini exposes top-level safeParse
        return z4mini.safeParse(schema as z4.$ZodType, data) as any;
    }
    return (schema as z3.ZodTypeAny).safeParse(data) as any;
}
```

The parsing API differs between versions:

- **v3**: Instance method `schema.safeParse(data)`
- **v4**: Top-level function `z4mini.safeParse(schema, data)`

Our wrapper abstracts this difference.

### `src/server/zod-json-schema-compat.ts`

JSON Schema conversion differs significantly between versions, requiring a compatibility layer.

#### The Challenge

- **Zod v3**: Uses external library `zod-to-json-schema` (vendored in `_vendor/`)
- **Zod v4**: Has built-in `toJSONSchema` method on schemas

#### Solution

```typescript
export function toJsonSchemaCompat(schema: AnyObjectSchema, opts?: CommonOpts): JsonSchema {
    if (isZ4Schema(schema)) {
        // v4 branch — use Mini's built-in toJSONSchema
        return z4mini.toJSONSchema(schema as z4.$ZodType, {
            target: mapMiniTarget(opts?.target),
            io: opts?.pipeStrategy ?? 'input'
        }) as JsonSchema;
    }

    // v3 branch — use vendored converter
    return zodToJsonSchema(
        schema as z3.ZodTypeAny,
        {
            strictUnions: opts?.strictUnions ?? true,
            pipeStrategy: opts?.pipeStrategy ?? 'input'
        } as any
    ) as JsonSchema;
}
```

#### Option Mapping

The options API differs between versions:

- **v3**: `strictUnions`, `pipeStrategy`, `target` (with values like `'jsonSchema7'`)
- **v4**: `target` (with values like `'draft-7'`), `io` (instead of `pipeStrategy`)

We map between these formats:

```typescript
function mapMiniTarget(t: CommonOpts['target'] | undefined): 'draft-7' | 'draft-2020-12' {
    if (!t) return 'draft-7';
    if (t === 'jsonSchema7' || t === 'draft-7') return 'draft-7';
    if (t === 'jsonSchema2019-09' || t === 'draft-2020-12') return 'draft-2020-12';
    return 'draft-7'; // fallback
}
```

### `src/_vendor/zod-to-json-schema/`

We **vendored** the `zod-to-json-schema` library for v3 compatibility. This means:

1. **No external dependency** on `zod-to-json-schema` (removed from `package.json`)
2. **Full control** over the implementation
3. **Version-specific imports** - all files import from `'zod/v3'` explicitly
4. **Isolation** - v3 conversion logic is completely separate from v4

#### Why Vendor?

- Zod v4 has built-in JSON Schema conversion, so `zod-to-json-schema` is only needed for v3
- Vendoring ensures we can fix bugs or make modifications without waiting for upstream
- Reduces dependency surface area
- Allows us to pin to a specific version that works with our codebase

#### Structure

The vendored code is a complete copy of `zod-to-json-schema` with:

- All imports changed to `'zod/v3'`
- All type references updated to use v3 types
- Original LICENSE and README preserved

### `src/server/completable.ts`

The completable feature allows schemas to provide autocompletion suggestions. This required a major refactor.

#### The Problem

**Before (v3-only):**

```typescript
export class Completable<T extends ZodTypeAny> extends ZodType<...> {
    _parse(input: ParseInput): ParseReturnType<this['_output']> {
        return this._def.type._parse({...});
    }
    unwrap() {
        return this._def.type;
    }
}
```

This approach:

- Extended Zod's base class (not possible in v4 due to API changes)
- Relied on Zod internals (`_def`, `_parse`, etc.) that changed in v4
- Required deep integration with Zod's type system

#### The Solution: Symbol-Based Metadata

**After (v3 + v4 compatible):**

```typescript
export const COMPLETABLE_SYMBOL: unique symbol = Symbol.for('mcp.completable');

export type CompletableSchema<T extends AnySchema> = T & {
    [COMPLETABLE_SYMBOL]: CompletableMeta<T>;
};

export function completable<T extends AnySchema>(schema: T, complete: CompleteCallback<T>): CompletableSchema<T> {
    Object.defineProperty(schema as object, COMPLETABLE_SYMBOL, {
        value: { complete } as CompletableMeta<T>,
        enumerable: false,
        writable: false,
        configurable: false
    });
    return schema as CompletableSchema<T>;
}
```

This approach:

- **No inheritance** - works with any schema type from either version
- **Non-intrusive** - doesn't modify parsing behavior
- **Version-agnostic** - uses standard JavaScript symbols
- **Backward compatible** - provides `unwrapCompletable()` helper for code that called `.unwrap()`

#### Detection

```typescript
export function isCompletable(schema: unknown): schema is CompletableSchema<AnySchema> {
    return !!schema && typeof schema === 'object' && COMPLETABLE_SYMBOL in (schema as object);
}

export function getCompleter<T extends AnySchema>(schema: T): CompleteCallback<T> | undefined {
    const meta = (schema as any)[COMPLETABLE_SYMBOL] as CompletableMeta<T> | undefined;
    return meta?.complete as CompleteCallback<T> | undefined;
}
```

### `src/server/mcp.ts`

The MCP server implementation was updated to use the compatibility layer throughout.

#### Key Changes

1. **Imports updated:**

```typescript
// Before
import { z, ZodRawShape, AnyZodObject, ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

// After
import { AnySchema, AnyObjectSchema, ZodRawShapeCompat, ObjectOutput, normalizeObjectSchema, safeParseAsync, safeParse, isZ4Schema } from './zod-compat.js';
import { toJsonSchemaCompat } from './zod-json-schema-compat.js';
```

2. **Schema normalization:**

```typescript
// Before
inputSchema: tool.inputSchema
    ? zodToJsonSchema(tool.inputSchema, {...})
    : EMPTY_OBJECT_JSON_SCHEMA

// After
inputSchema: (() => {
    const obj = normalizeObjectSchema(tool.inputSchema);
    return obj
        ? (toJsonSchemaCompat(obj, {...}) as Tool['inputSchema'])
        : EMPTY_OBJECT_JSON_SCHEMA;
})()
```

The `normalizeObjectSchema` function handles both:

- Already-constructed object schemas (v3 or v4)
- Raw shapes that need to be wrapped into object schemas

3. **Parsing updated:**

```typescript
// Before
const parseResult = await tool.inputSchema.safeParseAsync(request.params.arguments);

// After
const inputObj = normalizeObjectSchema(tool.inputSchema) as AnyObjectSchema;
const parseResult = await safeParseAsync(inputObj, request.params.arguments);
```

4. **Completable detection:**

```typescript
// Before
const field = prompt.argsSchema.shape[request.params.argument.name];
if (!(field instanceof Completable)) {
    return EMPTY_COMPLETION_RESULT;
}
const def: CompletableDef<ZodString> = field._def;
const suggestions = await def.complete(...);

// After
const promptShape = getObjectShape(prompt.argsSchema);
const field = promptShape?.[request.params.argument.name];
if (!isCompletable(field)) {
    return EMPTY_COMPLETION_RESULT;
}
const completer = getCompleter(field);
const suggestions = await completer(...);
```

5. **Shape extraction:**

```typescript
function getObjectShape(schema: AnyObjectSchema | undefined): Record<string, AnySchema> | undefined {
    if (!schema) return undefined;

    // Zod v3 exposes `.shape`; Zod v4 keeps the shape on `_zod.def.shape`
    const rawShape = (schema as any).shape ?? (isZ4Schema(schema) ? (schema as any)._zod?.def?.shape : undefined);

    if (!rawShape) return undefined;

    if (typeof rawShape === 'function') {
        try {
            return rawShape();
        } catch {
            return undefined;
        }
    }

    return rawShape as Record<string, AnySchema>;
}
```

This handles the difference in how object shapes are accessed:

- **v3**: `schema.shape` (direct property)
- **v4**: `schema._zod.def.shape` (nested, may be a function)

### `src/shared/protocol.ts`

The protocol layer handles request/response parsing and needed updates for schema handling.

#### Key Changes

1. **Type updates:**

```typescript
// Before
sendRequest: <U extends ZodType<object>>(request: SendRequestT, resultSchema: U, options?: RequestOptions) => Promise<z.infer<U>>;

// After
sendRequest: <U extends AnySchema>(request: SendRequestT, resultSchema: U, options?: RequestOptions) => Promise<SchemaOutput<U>>;
```

2. **Request handler signatures:**

```typescript
// Before
setRequestHandler<
    T extends ZodObject<{ method: ZodLiteral<string> }>
>(
    requestSchema: T,
    handler: (request: z.infer<T>, extra: ...) => ...
): void {
    const method = requestSchema.shape.method.value;
    this._requestHandlers.set(method, (request, extra) => {
        return Promise.resolve(handler(requestSchema.parse(request), extra));
    });
}

// After
setRequestHandler<T extends AnyObjectSchema>(
    requestSchema: T,
    handler: (request: SchemaOutput<T>, extra: ...) => ...
): void {
    const method = getMethodLiteral(requestSchema);
    this._requestHandlers.set(method, (request, extra) => {
        const parsed = parseWithCompat(requestSchema, request) as SchemaOutput<T>;
        return Promise.resolve(handler(parsed, extra));
    });
}
```

3. **Helper functions:**

```typescript
function getMethodLiteral(schema: AnyObjectSchema): string {
    const shape = getObjectShape(schema);
    const methodSchema = shape?.method as AnySchema | undefined;
    if (!methodSchema) {
        throw new Error('Schema is missing a method literal');
    }

    const value = getLiteralValue(methodSchema);
    if (typeof value !== 'string') {
        throw new Error('Schema method literal must be a string');
    }

    return value;
}

function getLiteralValue(schema: AnySchema): unknown {
    const v4Def = isZ4Schema(schema) ? (schema as any)._zod?.def : undefined;
    const legacyDef = (schema as any)._def;

    const candidates = [v4Def?.value, legacyDef?.value, Array.isArray(v4Def?.values) ? v4Def.values[0] : undefined, Array.isArray(legacyDef?.values) ? legacyDef.values[0] : undefined, (schema as any).value];

    for (const candidate of candidates) {
        if (typeof candidate !== 'undefined') {
            return candidate;
        }
    }

    return undefined;
}
```

These helpers extract literal values from schemas, handling differences in how v3 and v4 store this information.

### `src/types.ts`

The types file was updated to use Zod v4 by default:

```typescript
// Before
import * as z from 'zod';

// After
import * as z from 'zod/v4';
```

This means:

- **New code** defaults to v4 (smaller bundle, better performance)
- **Existing code** using v3 continues to work via the compatibility layer
- The SDK's internal types use v4, but accept v3 schemas from users

## Package.json Changes

### Dependencies

```json
{
    "dependencies": {
        "zod": "^3.25 || ^4.0"
    },
    "peerDependencies": {
        "zod": "^3.25 || ^4.0"
    }
}
```

Key points:

- **Range supports both versions** - `^3.25 || ^4.0` allows either
- **Peer dependency** - users must provide their own Zod installation
- **Removed `zod-to-json-schema`** - now vendored for v3 support

## Testing Strategy

### Dual Test Suites

We maintain **separate test files** for v3 and v4:

- **v4 tests**: `src/server/mcp.test.ts`, `src/server/index.test.ts`, etc.
- **v3 tests**: `src/server/v3/mcp.v3.test.ts`, `src/server/v3/index.v3.test.ts`, etc.

### Test File Pattern

Each v3 test file:

1. Imports from `'zod/v3'` explicitly
2. Uses v3-specific APIs (e.g., `.passthrough()` instead of `.looseObject()`)
3. Tests the same functionality as v4 tests
4. Verifies compatibility layer works correctly

Example from `src/server/v3/mcp.v3.test.ts`:

```typescript
import * as z from 'zod/v3';

// Uses v3-specific syntax
const RequestSchemaV3Base = z.object({
    method: z.string(),
    params: z.optional(z.object({ _meta: z.optional(z.object({})) }).passthrough())
});
```

### Why Separate Tests?

1. **API differences** - v3 and v4 have different APIs that need testing
2. **Type safety** - TypeScript can't always infer which version is being used
3. **Documentation** - Shows users how to use each version
4. **Regression prevention** - Ensures changes don't break either version

## Migration Guide for Re-application

When rebasing and re-applying these changes, follow this order:

### 1. Create Compatibility Layer

1. **Create `src/server/zod-compat.ts`**
    - Copy the unified types
    - Add runtime detection functions
    - Add schema construction helpers
    - Add unified parsing functions

2. **Create `src/server/zod-json-schema-compat.ts`**
    - Add JSON Schema conversion wrapper
    - Map options between versions
    - Handle both conversion paths

### 2. Vendor zod-to-json-schema

1. **Copy `zod-to-json-schema` to `src/_vendor/zod-to-json-schema/`**
2. **Update all imports** in vendored files to use `'zod/v3'`
3. **Update type references** to use v3 types
4. **Preserve LICENSE and README**

### 3. Update Completable

1. **Refactor `src/server/completable.ts`**
    - Remove class inheritance
    - Add symbol-based metadata
    - Add detection helpers
    - Add unwrap helper for backward compat

### 4. Update Core Files

1. **Update `src/server/mcp.ts`**
    - Replace Zod imports with compat imports
    - Update schema normalization calls
    - Update parsing calls
    - Update completable detection
    - Add shape extraction helpers

2. **Update `src/shared/protocol.ts`**
    - Replace Zod types with compat types
    - Update request handler signatures
    - Add helper functions for method/literal extraction
    - Update parsing calls

3. **Update `src/types.ts`**
    - Change import to `'zod/v4'`
    - Update schema definitions to use v4 APIs

### 5. Update Package.json

1. **Update zod dependency** to `"^3.25 || ^4.0"`
2. **Add zod as peerDependency**
3. **Remove `zod-to-json-schema` dependency**

### 6. Add Tests

1. **Create v3 test files** in `src/server/v3/`, `src/client/v3/`, etc.
2. **Update existing tests** to use v4 imports
3. **Ensure both test suites pass**

### 7. Update Examples

1. **Update example files** to use `'zod/v4'` (or show both options)
2. **Add comments** showing v3 alternative where relevant

## Key Challenges and Solutions

### Challenge 1: Type System Differences

**Problem**: v3 uses `ZodTypeAny`, v4 uses `$ZodType`. Type inference differs.

**Solution**: Conditional types that check which version and use appropriate inference:

```typescript
export type SchemaOutput<S> = S extends z3.ZodTypeAny ? z3.infer<S> : S extends z4.$ZodType ? z4.output<S> : never;
```

### Challenge 2: API Differences

**Problem**: Parsing, schema construction, and shape access all differ.

**Solution**: Wrapper functions that detect version and call appropriate API:

```typescript
export function safeParse<S extends AnySchema>(schema: S, data: unknown) {
    if (isZ4Schema(schema)) {
        return z4mini.safeParse(schema, data);
    }
    return schema.safeParse(data);
}
```

### Challenge 3: JSON Schema Conversion

**Problem**: v3 needs external library, v4 has built-in method.

**Solution**: Compatibility wrapper that routes to correct converter:

```typescript
export function toJsonSchemaCompat(schema: AnyObjectSchema, opts?: CommonOpts) {
    if (isZ4Schema(schema)) {
        return z4mini.toJSONSchema(schema, {...});
    }
    return zodToJsonSchema(schema, {...});
}
```

### Challenge 4: Extensibility (Completable)

**Problem**: Class inheritance doesn't work across versions.

**Solution**: Symbol-based metadata that works with any schema:

```typescript
export const COMPLETABLE_SYMBOL = Symbol.for('mcp.completable');
export function completable<T extends AnySchema>(schema: T, complete: ...) {
    Object.defineProperty(schema, COMPLETABLE_SYMBOL, {...});
    return schema;
}
```

### Challenge 5: Shape Access

**Problem**: v3 has `schema.shape`, v4 has `schema._zod.def.shape` (may be function).

**Solution**: Helper that checks both locations and handles functions:

```typescript
function getObjectShape(schema: AnyObjectSchema) {
    const rawShape = (schema as any).shape ?? (isZ4Schema(schema) ? (schema as any)._zod?.def?.shape : undefined);
    if (typeof rawShape === 'function') {
        return rawShape();
    }
    return rawShape;
}
```

## Best Practices

1. **Always use compat types** - Never import directly from `'zod'` in core code
2. **Normalize schemas early** - Use `normalizeObjectSchema()` when accepting schemas
3. **Use unified parsing** - Always use `safeParse()` / `safeParseAsync()` from compat
4. **Check version at runtime** - Use `isZ4Schema()` when needed, but prefer compat functions
5. **Don't mix versions** - Enforce single-version shapes
6. **Test both versions** - Maintain test coverage for v3 and v4

## Future Considerations

1. **Zod v4 Classic** - Currently using Mini; may need Classic support later
2. **Deprecation path** - Eventually may deprecate v3 support
3. **Performance** - Monitor bundle size impact of dual support
4. **Type improvements** - May be able to improve type inference with newer TypeScript features

## Summary

The Zod v4 compatibility approach uses:

- **Unified types** (`zod-compat.ts`) to abstract version differences
- **Runtime detection** (`isZ4Schema()`) to route to correct APIs
- **Compatibility wrappers** for parsing, JSON Schema conversion, etc.
- **Vendored dependencies** for v3-specific functionality
- **Symbol-based metadata** for extensibility without inheritance
- **Dual test suites** to ensure both versions work correctly

This approach maintains full backward compatibility while adding v4 support, allowing users to migrate at their own pace.

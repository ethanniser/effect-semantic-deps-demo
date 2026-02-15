import { Context, Effect, Layer } from "effect";

// =============================================================================
// Services are declared in types - the compiler knows about ALL dependencies
// =============================================================================

// Transaction is a pure semantic marker - no methods, just a type requirement
// If your function requires Transaction, it means you're inside a transaction
class Transaction extends Context.Tag("@app/Transaction")<Transaction, {}>() {
  // commit wraps an effect and provides the Transaction context
  static commit<A, E, R>(effect: Effect.Effect<A, E, R>) {
    return Effect.gen(function* () {
      console.log("[Transaction] BEGIN");
      const result = yield* effect.pipe(
        Effect.provide(Layer.succeed(Transaction, {})),
      );
      console.log("[Transaction] COMMIT");
      return result;
    });
  }
}

// LoggedInUser is a semantic marker that ALSO carries data (the user)
// If your function requires LoggedInUser, auth has been verified
class LoggedInUser extends Context.Tag("@app/LoggedInUser")<
  LoggedInUser,
  { readonly id: string; readonly email: string; readonly role: string }
>() {}

// WriteAccess is DERIVED from LoggedInUser - it's a semantic marker that
// means the user's role has been checked and they can perform writes.
// Functions requiring WriteAccess need both auth AND write permission.
class WriteAccess extends Context.Tag("@app/WriteAccess")<WriteAccess, {}>() {}

// Auth errors
class Unauthenticated extends Error {
  readonly _tag = "Unauthenticated";
  constructor() {
    super("Not authenticated");
  }
}

class Forbidden extends Error {
  readonly _tag = "Forbidden";
  constructor(readonly role: string) {
    super(`Role "${role}" does not have write access`);
  }
}

// checkAuthOrFail wraps an effect and provides LoggedInUser or fails
function checkAuthOrFail<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    // In real code, this would check a token/session
    const token = process.env.AUTH_TOKEN;
    if (!token) {
      return yield* Effect.fail(new Unauthenticated());
    }

    console.log("[Auth] Verified user from token");
    const user = { id: "user-123", email: "alice@example.com", role: "editor" };

    // Provide the LoggedInUser to the wrapped effect
    return yield* effect.pipe(
      Effect.provide(Layer.succeed(LoggedInUser, user)),
    );
  });
}

// checkWriteAccessOrFail DERIVES WriteAccess from LoggedInUser
// It reads the user's role and either grants WriteAccess or fails with Forbidden
function checkWriteAccessOrFail<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const user = yield* LoggedInUser;

    if (user.role !== "admin" && user.role !== "editor") {
      return yield* Effect.fail(new Forbidden(user.role));
    }

    console.log(`[WriteAccess] Granted for ${user.email} (role: ${user.role})`);

    // Provide WriteAccess to the wrapped effect
    return yield* effect.pipe(Effect.provide(Layer.succeed(WriteAccess, {})));
  });
}

// Rate limiter - consuming a rate limit slot is tracked in types
class RateLimiter extends Context.Tag("@app/RateLimiter")<
  RateLimiter,
  {
    readonly acquire: Effect.Effect<void>;
  }
>() {}

// Cosmos client - methods REQUIRE Transaction AND LoggedInUser
// upsertDocument ALSO requires WriteAccess (derived from user's role)
class CosmosClient extends Context.Tag("@app/CosmosClient")<
  CosmosClient,
  {
    // Read: requires Transaction + LoggedInUser
    readonly getDocument: (
      id: string,
    ) => Effect.Effect<unknown, never, Transaction | LoggedInUser>;
    // Write: requires Transaction + LoggedInUser + WriteAccess!
    readonly upsertDocument: (
      doc: unknown,
    ) => Effect.Effect<void, never, Transaction | LoggedInUser | WriteAccess>;
  }
>() {}

// Semantic only marker that a resource is locked
class Locked extends Context.Tag("@app/Locked")<Locked, {}>() {}

// A mutex service - holding a lock is type-tracked
class Mutex extends Context.Tag("@app/Mutex")<
  Mutex,
  {
    readonly acquire: Effect.Effect<void, never, Locked>;
  }
>() {
  declare static readonly release: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, Exclude<R, Locked>>;
}

// =============================================================================
// Look at these function signatures - EVERYTHING is visible in the type!
// =============================================================================

// This function talks to Cosmos, which requires Transaction AND LoggedInUser
// Both requirements bubble up!
function getAndUpdateUser(userId: string) {
  return Effect.gen(function* () {
    const cosmos = yield* CosmosClient;
    const user = yield* cosmos.getDocument(userId);
    yield* cosmos.upsertDocument({
      ...(user as object),
      accessedAt: new Date(),
    });
    return user;
  });
}
// Type: (userId: string) => Effect<unknown, never, CosmosClient | Transaction | LoggedInUser | WriteAccess>
//                                                               ^^^^^^^^^^^   ^^^^^^^^^^^^   ^^^^^^^^^^^
//                                                  All requirements bubble up! (WriteAccess from upsert)

// This function consumes rate limit AND requires transaction + auth (via cosmos)
function doSomethingComplex(userId: string) {
  return Effect.gen(function* () {
    const rateLimiter = yield* RateLimiter;
    yield* rateLimiter.acquire;

    const user = yield* getAndUpdateUser(userId);

    return user as string;
  });
}
// Type: (userId: string) => Effect<string, never, RateLimiter | CosmosClient | Transaction | LoggedInUser | WriteAccess>

// This function holds a mutex
function doSomethingWithMutex() {
  return Effect.gen(function* () {
    const mutex = yield* Mutex;
    yield* mutex.acquire;

    const cosmos = yield* CosmosClient;
    yield* cosmos.upsertDocument({ counter: 1 });

    return "done";
  });
}
// Type: () => Effect<string, never, Mutex | CosmosClient | Transaction | LoggedInUser | WriteAccess | Scope>

// =============================================================================
// Even ERRORS are in the type system!
// =============================================================================

class UserNotFound extends Error {
  readonly _tag = "UserNotFound";
  constructor(readonly userId: string) {
    super(`User not found: ${userId}`);
  }
}

function getUserOrFail(userId: string) {
  return Effect.gen(function* () {
    const rateLimiter = yield* RateLimiter;
    yield* rateLimiter.acquire;

    const cosmos = yield* CosmosClient;
    const user = yield* cosmos.getDocument(userId);

    if (!user) {
      return yield* Effect.fail(new UserNotFound(userId));
    }

    return user as { id: string; name: string };
  });
}
// Type: (userId: string) => Effect<{id: string, name: string}, UserNotFound, RateLimiter | CosmosClient | Transaction | LoggedInUser>
// Note: NO WriteAccess needed here - getUserOrFail only READS (getDocument), never writes!

// =============================================================================
// Composing functions - dependencies automatically merge
// =============================================================================

function orchestrate(userId: string) {
  return Effect.gen(function* () {
    const result = yield* doSomethingComplex(userId);
    yield* doSomethingWithMutex();
    return result;
  });
}
// Type: (userId: string) => Effect<string, never, RateLimiter | CosmosClient | Transaction | LoggedInUser | WriteAccess | Mutex | Scope>

// =============================================================================
// The magic: provide implementations at the edge
// =============================================================================

const ProductionRateLimiter = Layer.succeed(
  RateLimiter,
  RateLimiter.of({
    acquire: Effect.sync(() => {
      console.log("[RateLimit] Acquired slot");
    }),
  }),
);

const ProductionCosmos = Layer.succeed(
  CosmosClient,
  CosmosClient.of({
    getDocument: (id) =>
      Effect.gen(function* () {
        yield* Transaction; // Must be in transaction!
        const user = yield* LoggedInUser; // Must be authenticated!
        console.log(`[Cosmos] Get: ${id} (as ${user.email})`);
        return { id, name: "Alice" };
      }),
    upsertDocument: (doc) =>
      Effect.gen(function* () {
        yield* Transaction;
        const user = yield* LoggedInUser;
        yield* WriteAccess; // Must have write permission!
        console.log(
          `[Cosmos] Upsert (as ${user.email}, role: ${user.role}):`,
          doc,
        );
      }),
  }),
);

const ProductionMutex = Layer.effect(
  Mutex,
  Effect.sync(() =>
    Mutex.of({ acquire: Effect.sync(() => console.log("[Mutex] Acquired")) }),
  ),
);

const ProductionLayer = Layer.mergeAll(
  ProductionRateLimiter,
  ProductionCosmos,
  ProductionMutex,
);

// =============================================================================
// Run it - must wrap in checkAuthOrFail, checkWriteAccessOrFail, AND Transaction.commit
// =============================================================================

const main = Effect.gen(function* () {
  console.log(
    "\n--- Running doSomethingComplex (with auth + write access + transaction) ---",
  );
  // Must provide auth, write access, AND transaction
  const result = yield* doSomethingComplex("user-123").pipe(
    Transaction.commit,
    // checkAuthOrFail,
    checkWriteAccessOrFail, // derives WriteAccess from LoggedInUser
    // checkAuthOrFail is applied at the top level (see below)
  );
  console.log("Result:", result);

  console.log(
    "\n--- Running orchestrate (with auth + write access + transaction + mutex) ---",
  );
  const orchestrated = yield* orchestrate("user-456").pipe(
    Mutex.release,
    Transaction.commit,
    checkWriteAccessOrFail, // derives WriteAccess from LoggedInUser
    // checkAuthOrFail is applied at the top level (see below)
  );
  console.log("Orchestrated:", orchestrated);

  // This would NOT compile - missing LoggedInUser, Transaction, AND WriteAccess!
  // const bad = yield* doSomethingComplex("user-789")
  //                    ^ Error: LoggedInUser | Transaction | WriteAccess is missing from context
}).pipe(checkAuthOrFail); // provides LoggedInUser for everything above

// Set AUTH_TOKEN so auth passes
process.env.AUTH_TOKEN = "secret";

Effect.runPromise(main.pipe(Effect.provide(ProductionLayer)));

// =============================================================================
// KEY TAKEAWAYS:
//
// Look at any function's type signature and you IMMEDIATELY know:
// 1. What services it depends on (CosmosClient, RateLimiter, etc.)
// 2. What errors it can produce (UserNotFound, Unauthenticated, Forbidden, etc.)
// 3. Whether it holds resources (Scope requirement)
// 4. Whether it requires a transaction (Transaction requirement)
// 5. Whether it requires authentication (LoggedInUser requirement)
// 6. Whether it requires write permission (WriteAccess requirement)
//
// WriteAccess is DERIVED from LoggedInUser - checkWriteAccessOrFail reads
// the user's role and either grants WriteAccess or fails with Forbidden.
// This shows how permissions can be LAYERED: auth first, then authorization.
//
// Transaction, LoggedInUser, and WriteAccess are SEMANTIC markers.
// Cosmos read methods require Transaction + LoggedInUser.
// Cosmos write methods require Transaction + LoggedInUser + WriteAccess.
// Those requirements BUBBLE UP through every caller.
//
// If you forget checkAuthOrFail(), checkWriteAccessOrFail(), or
// Transaction.commit(), THE COMPILER TELLS YOU.
//
// Summary:
// - "function requires auth" -> requires LoggedInUser
// - "function requires write permission" -> requires WriteAccess (derived from user)
// - "function uses a transaction" -> requires Transaction
// - "will hold a mutex" -> requires Mutex + Scope
// - "will consume a rate limit" -> requires RateLimiter
// - "will read from cosmos" -> requires CosmosClient + Transaction + LoggedInUser
// - "will write to cosmos" -> requires CosmosClient + Transaction + LoggedInUser + WriteAccess
//
// All statically known. All in the types. No runtime surprises.
// The compiler enforces it.
// =============================================================================

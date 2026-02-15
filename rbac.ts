import { Context, Effect, Layer } from "effect";

// =============================================================================
// RBAC Framework - Role-Based Access Control with Effect
//
// Permissions are tracked at the type level. Wrapping an effect with
// `requires("write", "posts")` adds `Requires<"write", "posts">`
// to its type signature. The compiler enforces that every permission
// is authorized before the program can run.
// =============================================================================

// --- Permission types ---

// Branded type representing a required permission for Action on Resource.
// When this appears in an Effect's R (requirements), it means
// "this code path needs <Action> permission on <Resource>."
interface Requires<out Action extends string, out Resource extends string> {
  readonly _tag: `Requires<${Action}, ${Resource}>`;
}

// Internal: get or create a permission tag (cached by key so the same
// tag instance is shared between `requires` and `authorize`).
const _tags = new Map<string, Context.Tag<any, any>>();
const _tag = <A extends string, R extends string>(action: A, resource: R) => {
  const key = `@rbac/${action}:${resource}`;
  if (!_tags.has(key)) _tags.set(key, Context.GenericTag(key));
  return _tags.get(key)! as Context.Tag<Requires<A, R>, {}>;
};

// --- Public API: requires ---

// Wrap an effect to declare a permission requirement.
// Usage: `requires("write", "posts")(effect)` or `effect.pipe(requires("write", "posts"))`
// This adds `Requires<"write", "posts">` to the Effect's requirements.
function requires<const A extends string, const R extends string>(
  action: A,
  resource: R,
) {
  const tag = _tag(action, resource);
  return <Eff_A, Eff_E, Eff_R>(effect: Effect.Effect<Eff_A, Eff_E, Eff_R>) =>
    Effect.gen(function* () {
      yield* tag;
      return yield* effect;
    });
}

// --- User context (provided from environment) ---

class CurrentUser extends Context.Tag("@rbac/CurrentUser")<
  CurrentUser,
  { readonly id: string; readonly roles: ReadonlyArray<string> }
>() {}

// --- Errors ---

class Unauthenticated extends Error {
  readonly _tag = "Unauthenticated";
  constructor() {
    super("Not authenticated");
  }
}

class AccessDenied extends Error {
  readonly _tag = "AccessDenied";
  constructor(
    readonly permission: string,
    readonly userRoles: ReadonlyArray<string>,
  ) {
    super(
      `Access denied: "${permission}" not granted to roles [${userRoles.join(", ")}]`,
    );
  }
}

// --- Role definitions ---

const rolePermissions: Record<string, ReadonlyArray<string>> = {
  admin: [
    "read:posts",
    "write:posts",
    "delete:posts",
    "read:users",
    "write:users",
  ],
  editor: ["read:posts", "write:posts", "read:users"],
  viewer: ["read:posts", "read:users"],
};

// --- Middleware ---

// authenticate: reads from environment, provides CurrentUser.
// CurrentUser depends on env — if there's no token, we fail.
function authenticate<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    // In real code: read a JWT from headers, verify it, look up the user
    const token = process.env.AUTH_TOKEN;
    if (!token) return yield* Effect.fail(new Unauthenticated());

    const user = { id: "user-1", roles: ["editor"] as ReadonlyArray<string> };
    console.log(
      `[Auth] Authenticated ${user.id} (roles: ${user.roles.join(", ")})`,
    );

    return yield* effect.pipe(Effect.provide(Layer.succeed(CurrentUser, user)));
  });
}

// authorize: reads CurrentUser (so it depends on auth), checks their
// roles against the requested permission, and provides it if allowed.
function authorize<const A extends string, const R extends string>(
  action: A,
  resource: R,
) {
  const tag = _tag(action, resource);
  const key = `${action}:${resource}`;

  return <Eff_A, Eff_E, Eff_R>(effect: Effect.Effect<Eff_A, Eff_E, Eff_R>) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser;
      const granted = user.roles.flatMap((r) => [
        ...(rolePermissions[r] ?? []),
      ]);

      if (!granted.includes(key)) {
        return yield* Effect.fail(new AccessDenied(key, user.roles));
      }

      console.log(`[RBAC] "${key}" granted to ${user.id}`);
      return yield* effect.pipe(Effect.provide(Layer.succeed(tag, {})));
    });
}

// =============================================================================
// Business logic — look at how permissions appear in the types!
// =============================================================================

function listPosts() {
  return Effect.gen(function* () {
    console.log("[Posts] Listing posts");
    return [
      { id: 1, title: "Hello" },
      { id: 2, title: "World" },
    ];
  }).pipe(requires("read", "posts"));
}
// Type: () => Effect<Post[], never, Requires<"read", "posts">>

function createPost(title: string) {
  return Effect.gen(function* () {
    console.log(`[Posts] Creating: "${title}"`);
    return { id: 3, title };
  }).pipe(requires("write", "posts"));
}
// Type: (title: string) => Effect<Post, never, Requires<"write", "posts">>

function deletePost(id: number) {
  return Effect.gen(function* () {
    console.log(`[Posts] Deleting post ${id}`);
  }).pipe(
    requires("read", "posts"), //   must read to verify it exists
    requires("delete", "posts"), // must have delete permission
  );
}
// Type: (id: number) => Effect<void, never, Requires<"read", "posts"> | Requires<"delete", "posts">>
//                                           ^^^ BOTH permissions bubble up!

// Composed functions merge requirements automatically
function publishWorkflow(title: string) {
  return Effect.gen(function* () {
    const posts = yield* listPosts();
    const newPost = yield* createPost(title);
    console.log(`[Workflow] Published "${title}" (total: ${posts.length + 1})`);
    return newPost;
  });
}
// Type: (title: string) => Effect<Post, never, Requires<"read", "posts"> | Requires<"write", "posts">>
//       Requirements from BOTH listPosts and createPost merge automatically!

// =============================================================================
// Running — permissions must be authorized at the edge
// =============================================================================

process.env.AUTH_TOKEN = "secret";

const main = Effect.gen(function* () {
  // --- Happy path: editor can read + write posts ---
  console.log("=== Editor publishes a post ===\n");
  const post = yield* publishWorkflow("My Post").pipe(
    authorize("write", "posts"), // checks editor has write:posts -> yes
    authorize("read", "posts"), //  checks editor has read:posts  -> yes
  );
  console.log("Created:", post);

  // --- Sad path: editor tries to delete (not in their role) ---
  console.log("\n=== Editor tries to delete a post ===\n");
  const result = yield* deletePost(1).pipe(
    authorize("delete", "posts"), // checks editor has delete:posts -> NO!
    authorize("read", "posts"),
  );
  console.log("Result:", result);

  // --- This would NOT compile! Uncomment to see the error: ---
  // yield* createPost("Nope")
  //   ^ Type error: Requires<"write", "posts"> is not provided
}).pipe(authenticate); // provides CurrentUser from env

Effect.runPromise(main);

// =============================================================================
// Dependency chain:
//
//   effect.pipe(
//     requires("write", "posts"),   wraps effect, adds Requires<"write", "posts"> to type
//     authorize("write", "posts"),  reads CurrentUser, checks role, provides permission
//     authenticate,                 reads env, provides CurrentUser
//   )
//
// The type system tracks every link. If you skip authorize or authenticate,
// the compiler tells you exactly which requirement is missing.
//
// Summary:
//   requires(A, R)  -> wraps effect, adds dependency on Requires<A, R>
//   authorize(A, R) -> wraps effect, resolves Requires<A, R>, depends on CurrentUser
//   authenticate    -> wraps effect, resolves CurrentUser, depends on env
//
// All statically known. All in the types. The compiler enforces it.
// =============================================================================

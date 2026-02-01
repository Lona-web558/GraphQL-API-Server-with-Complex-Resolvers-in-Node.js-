# GraphQL-API-Server-with-Complex-Resolvers-in-Node.js-
GraphQL API Server with Complex Resolvers in Node.js 

# GraphQL API Server

A fully functional GraphQL API server built from scratch in a single file using only Node.js built-in modules. No npm packages, no frameworks — just `require("http")`.

## Quick Start

```sh
node server.js
```

The server boots on port 4000. Open your browser to the interactive GraphiQL IDE:

```
http://localhost:4000/graphql
```

Or hit the root URL for a plain-text health check:

```
http://localhost:4000/
```

## How It Works

Everything lives in `server.js`, laid out top-to-bottom in the order the pipeline runs:

| Section | What it does |
|---|---|
| **Tokeniser** | Breaks a raw query string into a flat array of typed tokens (punctuation, strings, ints, booleans, names, enums). |
| **Parser** | Recursive-descent parser that consumes the token stream and produces an AST. Supports queries, mutations, aliases, arguments, nested selection sets, and all GraphQL value types (strings, ints, booleans, null, enums, lists, input objects). |
| **Executor** | Walks the AST top-down. For each field it checks the current parent object: if the field is a function it calls it (passing any arguments), otherwise it reads the property directly. Recurses into sub-selections automatically, handling single objects, arrays, and paginated wrappers. |
| **Database** | Four in-memory arrays (`users`, `posts`, `comments`, `profiles`) pre-seeded with data. Finder functions, mutation helpers (add/update/delete), and a generic `paginateArray` utility. `deletePost` cascades and removes all comments on that post. |
| **Resolvers** | Four wrapper functions (`wrapUser`, `wrapPost`, `wrapComment`, `wrapProfile`) that turn raw data rows into objects whose nested fields are resolver functions — the executor calls them only when the client actually selects that field. A root resolver object maps every top-level query and mutation name to its handler. |
| **GraphiQL IDE** | A self-contained dark-themed HTML page served on `GET /graphql`. No external CSS or JS libraries. |
| **HTTP Server** | Three routes: `GET /` (health check), `GET /graphql` (IDE), `POST /graphql` (execute). Follows the GraphQL-over-HTTP convention of always returning status 200 and putting errors in the response body. |

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | Plain-text health check |
| `GET` | `/graphql` | Serves the GraphiQL IDE |
| `POST` | `/graphql` | Executes a query or mutation |

POST body must be JSON with a `query` field:

```json
{
  "query": "{ users { id name } }"
}
```

## Queries

### `user(id: String)`
Single user by ID. Supports nested `profile`, `posts`, `comments`, `postCount`, and `commentCount`.

```graphql
{
  user(id: "1") {
    name
    email
    role
    profile { bio location website }
    posts { title }
    postCount
    commentCount
  }
}
```

### `users`
All users.

```graphql
{ users { id name email role } }
```

### `userByEmail(email: String)`
Look up a single user by email address.

```graphql
{ userByEmail(email: "alice@example.com") { id name role } }
```

### `post(id: String)`
Single post by ID. Supports nested `author`, `comments`, `commentCount`, and `relatedPosts` (other posts sharing at least one tag, deduplicated).

```graphql
{
  post(id: "101") {
    title
    tags
    author { name profile { bio } }
    comments { body author { name } }
    relatedPosts { id title }
  }
}
```

### `posts(limit, offset, sortField, sortOrder)`
Paginated and sortable post list. Returns `{ items, totalCount, hasMore }`.

| Argument | Type | Values |
|---|---|---|
| `limit` | Int | number of items per page |
| `offset` | Int | skip this many items |
| `sortField` | Enum | `TITLE`, `COMMENT_COUNT`, `CREATED_AT` |
| `sortOrder` | Enum | `ASC`, `DESC` (default `DESC`) |

```graphql
{
  posts(limit: 3, offset: 0, sortField: CREATED_AT, sortOrder: DESC) {
    items {
      id
      title
      author { name }
      commentCount
    }
    totalCount
    hasMore
  }
}
```

### `postsByAuthor(authorId: String)`
All posts written by a specific user.

```graphql
{ postsByAuthor(authorId: "1") { id title } }
```

### `postsByTag(tag: String)`
All posts carrying a specific tag.

```graphql
{ postsByTag(tag: "graphql") { id title } }
```

### `searchPosts(keyword: String)`
Full-text search across post titles, bodies, and tags (case-insensitive).

```graphql
{ searchPosts(keyword: "graphql") { id title tags } }
```

### `comment(id: String)`
Single comment by ID. Supports nested `author` and back-reference to its `post`.

```graphql
{
  comment(id: "201") {
    body
    author { name }
    post { title }
  }
}
```

### `commentsOnPost(postId, limit, offset)`
Paginated comments for a given post. Same `{ items, totalCount, hasMore }` shape as `posts`.

```graphql
{
  commentsOnPost(postId: "101", limit: 5) {
    items { body author { name } }
    totalCount
    hasMore
  }
}
```

### `profile(userId: String)`
A user's profile. Supports a back-reference to its `user`.

```graphql
{ profile(userId: "1") { bio avatar website location } }
```

### `siteStats`
Aggregated site-wide statistics: total counts, top 5 tags by frequency, and top 3 users ranked by combined posts + comments.

```graphql
{
  siteStats {
    totalUsers
    totalPosts
    totalComments
    topTags { tag postCount }
    topUsers { user { name } postCount commentCount totalEngagement }
  }
}
```

## Mutations

### `createUser(input: { name, email, role })`
Creates a new user and an empty profile for them automatically. `role` defaults to `USER`.

```graphql
mutation {
  createUser(input: { name: "Jane Doe", email: "jane@example.com", role: ADMIN }) {
    id name email role
    profile { bio }
  }
}
```

### `createPost(input: { title, body, authorId, tags, published })`
Creates a post. Validates that the author ID exists. `tags` defaults to `[]`, `published` defaults to `false`.

```graphql
mutation {
  createPost(input: {
    title: "My First Post"
    body: "Hello world."
    authorId: "1"
    tags: ["intro"]
    published: true
  }) {
    id title author { name } tags published
  }
}
```

### `updatePost(id: String, input: { title, body, tags, published })`
Partially updates a post. Only the fields present in `input` are changed.

```graphql
mutation {
  updatePost(id: "101", input: { title: "Updated Title", published: false }) {
    id title published
  }
}
```

### `deletePost(id: String)`
Deletes a post and cascades to remove all of its comments. Returns `true` on success.

```graphql
mutation { deletePost(id: "101") }
```

### `createComment(input: { postId, authorId, body })`
Creates a comment. Validates that both the post and the author exist.

```graphql
mutation {
  createComment(input: { postId: "101", authorId: "2", body: "Great article!" }) {
    id body author { name } post { title }
  }
}
```

### `deleteComment(id: String)`
Deletes a single comment. Returns `true` on success.

```graphql
mutation { deleteComment(id: "201") }
```

### `updateProfile(userId: String, input: { bio, avatar, website, location })`
Partially updates a user's profile. Only the fields present in `input` are changed.

```graphql
mutation {
  updateProfile(userId: "1", input: { bio: "New bio", location: "Berlin, DE" }) {
    bio location
  }
}
```

## Aliases

You can alias any field to query the same resolver multiple times in one request:

```graphql
{
  first:  user(id: "1") { name }
  second: user(id: "2") { name }
}
```

## Seed Data

The server starts with pre-loaded data so you can query immediately:

| Entity | Count | IDs |
|---|---|---|
| Users | 5 | `1` – `5` |
| Posts | 8 | `101` – `108` |
| Comments | 15 | `201` – `215` |
| Profiles | 5 | one per user |

All data lives in memory. Mutations take effect for the lifetime of the process and are lost on restart.


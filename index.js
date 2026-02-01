// ============================================================
// server.js — Pure Node.js HTTP Server (no frameworks)
//   • POST /graphql   – executes GraphQL queries & mutations
//   • GET  /graphql   – serves a built-in GraphiQL IDE page
//   • GET  /          – simple welcome message
//
//   Run:  node server.js
//   URL:  http://localhost:4000/graphql
// ============================================================

var http = require("http");

var PORT = 3000;

// ============================================================
// TOKENISER (inlined from parser.js)
// Breaks a raw query string into an array of { type, value }.
// ============================================================
function tokenize(source) {
  var tokens = [];
  var i = 0;
  var len = source.length;

  while (i < len) {
    var ch = source[i];

    // --- skip whitespace & commas (commas are insignificant in GraphQL) ---
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i++;
      continue;
    }

    // --- single-character punctuation ---
    if (ch === '{') { tokens.push({ type: 'LBRACE',   value: '{' }); i++; continue; }
    if (ch === '}') { tokens.push({ type: 'RBRACE',   value: '}' }); i++; continue; }
    if (ch === '(') { tokens.push({ type: 'LPAREN',   value: '(' }); i++; continue; }
    if (ch === ')') { tokens.push({ type: 'RPAREN',   value: ')' }); i++; continue; }
    if (ch === '[') { tokens.push({ type: 'LBRACKET', value: '[' }); i++; continue; }
    if (ch === ']') { tokens.push({ type: 'RBRACKET', value: ']' }); i++; continue; }
    if (ch === ':') { tokens.push({ type: 'COLON',    value: ':' }); i++; continue; }
    if (ch === '!') { tokens.push({ type: 'BANG',     value: '!' }); i++; continue; }

    // --- string literal (double-quoted) ---
    if (ch === '"') {
      i++; // skip opening quote
      var str = '';
      while (i < len && source[i] !== '"') {
        if (source[i] === '\\') {
          i++;
          if (source[i] === 'n')       { str += '\n'; }
          else if (source[i] === 't')  { str += '\t'; }
          else if (source[i] === '"')  { str += '"'; }
          else if (source[i] === '\\') { str += '\\'; }
          else { str += source[i]; }
        } else {
          str += source[i];
        }
        i++;
      }
      i++; // skip closing quote
      tokens.push({ type: 'STRING', value: str });
      continue;
    }

    // --- number literal (int only, sufficient for limit/offset) ---
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      var numStr = '';
      if (ch === '-') { numStr += '-'; i++; }
      while (i < len && source[i] >= '0' && source[i] <= '9') {
        numStr += source[i];
        i++;
      }
      tokens.push({ type: 'INT', value: numStr });
      continue;
    }

    // --- name / keyword / boolean / null (bare words) ---
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_') {
      var name = '';
      while (i < len) {
        var c = source[i];
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
            (c >= '0' && c <= '9') || c === '_') {
          name += c;
          i++;
        } else {
          break;
        }
      }
      if (name === 'true' || name === 'false') {
        tokens.push({ type: 'BOOLEAN', value: name === 'true' });
      } else if (name === 'null') {
        tokens.push({ type: 'NULL', value: null });
      } else {
        tokens.push({ type: 'NAME', value: name });
      }
      continue;
    }

    // --- unknown character — skip it ---
    i++;
  }

  return tokens;
}

// ============================================================
// PARSER (inlined from parser.js)
// Recursive-descent parser. Produces an AST object.
//
// AST node types produced:
//   { kind: 'Document',      definitions: [...] }
//   { kind: 'OperationDef',  operation: 'query'|'mutation', selectionSet: [...] }
//   { kind: 'Field',         name, alias, arguments, selectionSet }
//   { kind: 'Argument',      name, value }
//   value nodes: { kind: 'IntValue'|'StringValue'|'BooleanValue'|'NullValue'|'EnumValue'|'ListValue'|'ObjectValue', value }
// ============================================================
function Parser(tokens) {
  this.tokens = tokens;
  this.pos    = 0;
}

Parser.prototype.peek = function() {
  return this.tokens[this.pos] || null;
};

Parser.prototype.advance = function() {
  var tok = this.tokens[this.pos];
  this.pos++;
  return tok;
};

Parser.prototype.expect = function(type) {
  var tok = this.advance();
  if (!tok || tok.type !== type) {
    throw new Error('Expected token type ' + type + ' but got ' + (tok ? tok.type + '(' + tok.value + ')' : 'EOF'));
  }
  return tok;
};

// --- Entry: parse the full document ---
Parser.prototype.parseDocument = function() {
  var definitions = [];
  while (this.peek()) {
    definitions.push(this.parseDefinition());
  }
  return { kind: 'Document', definitions: definitions };
};

// --- A definition is either an explicit operation or a shorthand selection set ---
Parser.prototype.parseDefinition = function() {
  var tok = this.peek();

  // shorthand: bare { ... } means anonymous query
  if (tok.type === 'LBRACE') {
    return {
      kind:         'OperationDef',
      operation:    'query',
      selectionSet: this.parseSelectionSet()
    };
  }

  // explicit: query { ... }  or  mutation { ... }
  var opTok = this.advance();        // 'query' or 'mutation'
  var operation = opTok.value;       // "query" or "mutation"

  // optional operation name — skip it if present before the brace
  if (this.peek() && this.peek().type === 'NAME') {
    this.advance(); // discard the name
  }

  return {
    kind:         'OperationDef',
    operation:    operation,
    selectionSet: this.parseSelectionSet()
  };
};

// --- { field field field ... } ---
Parser.prototype.parseSelectionSet = function() {
  this.expect('LBRACE');
  var selections = [];
  while (this.peek() && this.peek().type !== 'RBRACE') {
    selections.push(this.parseField());
  }
  this.expect('RBRACE');
  return selections;
};

// --- fieldName  or  alias: fieldName(args){ sub } ---
Parser.prototype.parseField = function() {
  var first = this.advance(); // NAME
  var alias = null;
  var name  = first.value;

  // check for alias  →  alias : realName
  if (this.peek() && this.peek().type === 'COLON') {
    this.advance();                  // consume ':'
    alias = first.value;
    name  = this.advance().value;    // the real field name
  }

  // optional arguments  ( key: value, ... )
  var args = [];
  if (this.peek() && this.peek().type === 'LPAREN') {
    args = this.parseArguments();
  }

  // optional sub-selection  { ... }
  var selectionSet = null;
  if (this.peek() && this.peek().type === 'LBRACE') {
    selectionSet = this.parseSelectionSet();
  }

  return {
    kind:         'Field',
    name:         name,
    alias:        alias,
    arguments:    args,
    selectionSet: selectionSet
  };
};

// --- ( name: value, name: value ) ---
Parser.prototype.parseArguments = function() {
  this.expect('LPAREN');
  var args = [];
  while (this.peek() && this.peek().type !== 'RPAREN') {
    var argName = this.advance().value; // NAME
    this.expect('COLON');
    var argVal  = this.parseValue();
    args.push({ kind: 'Argument', name: argName, value: argVal });
  }
  this.expect('RPAREN');
  return args;
};

// --- parse a single value (string, int, bool, null, enum, list, or input-object) ---
Parser.prototype.parseValue = function() {
  var tok = this.peek();

  if (tok.type === 'STRING') {
    this.advance();
    return { kind: 'StringValue', value: tok.value };
  }
  if (tok.type === 'INT') {
    this.advance();
    return { kind: 'IntValue', value: parseInt(tok.value, 10) };
  }
  if (tok.type === 'BOOLEAN') {
    this.advance();
    return { kind: 'BooleanValue', value: tok.value };
  }
  if (tok.type === 'NULL') {
    this.advance();
    return { kind: 'NullValue', value: null };
  }

  // list value  [ val, val, ... ]
  if (tok.type === 'LBRACKET') {
    this.advance(); // consume [
    var items = [];
    while (this.peek() && this.peek().type !== 'RBRACKET') {
      items.push(this.parseValue());
    }
    this.expect('RBRACKET');
    return { kind: 'ListValue', value: items };
  }

  // input-object value  { key: val, key: val }
  if (tok.type === 'LBRACE') {
    this.advance(); // consume {
    var fields = [];
    while (this.peek() && this.peek().type !== 'RBRACE') {
      var fieldName = this.advance().value;
      this.expect('COLON');
      var fieldVal  = this.parseValue();
      fields.push({ name: fieldName, value: fieldVal });
    }
    this.expect('RBRACE');
    return { kind: 'ObjectValue', value: fields };
  }

  // NAME that is not a keyword → treat as enum value
  if (tok.type === 'NAME') {
    this.advance();
    return { kind: 'EnumValue', value: tok.value };
  }

  throw new Error('Unexpected token while parsing value: ' + tok.type + '(' + tok.value + ')');
};

// --- public entry: queryString → AST ---
function parse(queryString) {
  var tokens = tokenize(queryString);
  var p = new Parser(tokens);
  return p.parseDocument();
}

// ============================================================
// EXECUTOR (inlined from executor.js)
// Walks the parsed AST, calls resolvers, recursively resolves
// nested fields, and returns a JSON-ready result.
// ============================================================

// --------------------------------------------------------
// Collapse an AST value node into a plain JS value
// --------------------------------------------------------
function coerceValue(node) {
  switch (node.kind) {
    case 'StringValue':  return node.value;
    case 'IntValue':     return node.value;           // already parseInt'd by parser
    case 'BooleanValue': return node.value;
    case 'NullValue':    return null;
    case 'EnumValue':    return node.value;           // kept as string, e.g. "ADMIN"
    case 'ListValue':
      return node.value.map(coerceValue);
    case 'ObjectValue':
      var obj = {};
      node.value.forEach(function(field) {
        obj[field.name] = coerceValue(field.value);
      });
      return obj;
    default:
      return node.value;
  }
}

// --------------------------------------------------------
// Extract arguments from a Field AST node into a plain object
// --------------------------------------------------------
function extractArgs(fieldNode) {
  var args = {};
  if (!fieldNode.arguments) return args;
  fieldNode.arguments.forEach(function(arg) {
    args[arg.name] = coerceValue(arg.value);
  });
  return args;
}

// --------------------------------------------------------
// Core recursive executor
//   parent     – the JS value the current selection set runs against
//   selections – array of Field AST nodes
// Returns a plain object or array ready for JSON serialisation.
// --------------------------------------------------------
function executeSelections(parent, selections) {
  var result = {};

  selections.forEach(function(fieldNode) {
    var fieldName = fieldNode.name;
    var alias     = fieldNode.alias || fieldName;
    var args      = extractArgs(fieldNode);
    var value;

    // 1) If parent has a function with this field name, call it
    //    (this is how nested resolvers work — wrapUser / wrapPost / etc.)
    if (typeof parent[fieldName] === 'function') {
      value = parent[fieldName](args);
    }
    // 2) Otherwise just read the property directly
    else if (parent[fieldName] !== undefined) {
      value = parent[fieldName];
    }
    // 3) Unknown field — null
    else {
      value = null;
    }

    // If this field has a sub-selection, recurse into it.
    // value could be: a single object, an array, or a paginated wrapper.
    if (fieldNode.selectionSet) {
      value = resolveNested(value, fieldNode.selectionSet);
    }

    result[alias] = value;
  });

  return result;
}

// --------------------------------------------------------
// Recurse into a value that may be an object, array, or null
// --------------------------------------------------------
function resolveNested(value, selectionSet) {
  if (value === null || value === undefined) return null;

  if (Array.isArray(value)) {
    return value.map(function(item) {
      return resolveNested(item, selectionSet);
    });
  }

  // plain object — run selections against it
  return executeSelections(value, selectionSet);
}

// --------------------------------------------------------
// Main entry: execute a parsed AST document
//   ast – the Document node returned by parse()
// Returns { data: {...} } or { errors: [{message}] }
// --------------------------------------------------------
function execute(ast) {
  try {
    var definition = ast.definitions[0];
    if (!definition) {
      return { errors: [{ message: 'Empty document.' }] };
    }

    var selectionSet = definition.selectionSet;

    // Execute each top-level field against the root resolver object
    var data = executeSelections(resolvers, selectionSet);

    return { data: data };

  } catch (err) {
    return { errors: [{ message: err.message }] };
  }
}

// ============================================================
// IN-MEMORY DATABASE (inlined from db.js)
// Seed data, finders, mutation helpers, pagination.
// ============================================================

var users = [
  { id: "1", name: "Alice Johnson",  email: "alice@example.com",   role: "ADMIN",     createdAt: "2024-01-10T08:00:00Z" },
  { id: "2", name: "Bob Smith",      email: "bob@example.com",     role: "USER",      createdAt: "2024-02-15T10:30:00Z" },
  { id: "3", name: "Charlie Brown",  email: "charlie@example.com", role: "USER",      createdAt: "2024-03-20T14:00:00Z" },
  { id: "4", name: "Diana Prince",   email: "diana@example.com",   role: "MODERATOR", createdAt: "2024-04-05T09:15:00Z" },
  { id: "5", name: "Edward Norton",  email: "edward@example.com",  role: "USER",      createdAt: "2024-05-12T16:45:00Z" }
];

var posts = [
  { id: "101", title: "Getting Started with GraphQL",  body: "GraphQL is a query language for APIs and a runtime for fulfilling those queries.",     authorId: "1", tags: ["graphql","api","tutorial"],       createdAt: "2024-06-01T08:00:00Z", published: true  },
  { id: "102", title: "Understanding Resolvers",       body: "Resolvers are the heart of any GraphQL server. They map schema fields to data.",      authorId: "1", tags: ["graphql","resolvers"],            createdAt: "2024-06-10T10:00:00Z", published: true  },
  { id: "103", title: "Node.js Best Practices",        body: "Here are proven best practices when building applications with Node.js.",             authorId: "2", tags: ["nodejs","javascript","backend"],  createdAt: "2024-06-15T12:00:00Z", published: true  },
  { id: "104", title: "REST vs GraphQL",               body: "A detailed comparison of REST and GraphQL approaches to API design.",                 authorId: "3", tags: ["graphql","rest","comparison"],    createdAt: "2024-07-01T09:00:00Z", published: true  },
  { id: "105", title: "Advanced Mutation Patterns",   body: "Mutations in GraphQL can be complex. Here is how to handle them gracefully.",        authorId: "2", tags: ["graphql","mutations"],            createdAt: "2024-07-20T11:00:00Z", published: false },
  { id: "106", title: "Database Design for APIs",     body: "A good database schema is the backbone of any robust API.",                          authorId: "4", tags: ["database","design","api"],        createdAt: "2024-08-05T14:00:00Z", published: true  },
  { id: "107", title: "Authentication in GraphQL",    body: "Learn how to secure your GraphQL API using tokens and middleware.",                   authorId: "1", tags: ["graphql","security","auth"],      createdAt: "2024-08-18T07:30:00Z", published: true  },
  { id: "108", title: "Working with Subscriptions",  body: "Real-time data delivery with GraphQL subscriptions explained.",                      authorId: "5", tags: ["graphql","realtime"],             createdAt: "2024-09-02T16:00:00Z", published: true  }
];

var comments = [
  { id: "201", postId: "101", authorId: "2", body: "Great intro, very helpful!",                      createdAt: "2024-06-02T09:00:00Z" },
  { id: "202", postId: "101", authorId: "3", body: "I was looking for exactly this.",                 createdAt: "2024-06-03T10:30:00Z" },
  { id: "203", postId: "101", authorId: "4", body: "Could you cover subscriptions too?",              createdAt: "2024-06-04T11:00:00Z" },
  { id: "204", postId: "102", authorId: "5", body: "Resolvers are indeed the core of GraphQL.",       createdAt: "2024-06-11T08:00:00Z" },
  { id: "205", postId: "102", authorId: "2", body: "Nice deep dive into nested resolvers.",           createdAt: "2024-06-12T14:00:00Z" },
  { id: "206", postId: "103", authorId: "1", body: "Point number 3 is so important.",                 createdAt: "2024-06-16T10:00:00Z" },
  { id: "207", postId: "103", authorId: "4", body: "I would also add error handling best practices.",createdAt: "2024-06-17T12:00:00Z" },
  { id: "208", postId: "104", authorId: "1", body: "GraphQL wins for complex client requirements.",  createdAt: "2024-07-02T09:00:00Z" },
  { id: "209", postId: "104", authorId: "5", body: "REST is still great for simple use cases.",      createdAt: "2024-07-03T15:00:00Z" },
  { id: "210", postId: "106", authorId: "2", body: "Normalization is key!",                          createdAt: "2024-08-06T08:00:00Z" },
  { id: "211", postId: "106", authorId: "3", body: "What about NoSQL approaches?",                   createdAt: "2024-08-07T10:00:00Z" },
  { id: "212", postId: "107", authorId: "3", body: "JWT tokens are my go-to for auth.",              createdAt: "2024-08-19T11:00:00Z" },
  { id: "213", postId: "107", authorId: "5", body: "OAuth2 is also worth exploring.",                createdAt: "2024-08-20T13:00:00Z" },
  { id: "214", postId: "108", authorId: "1", body: "Subscriptions changed everything for us.",      createdAt: "2024-09-03T09:00:00Z" },
  { id: "215", postId: "108", authorId: "4", body: "We use WebSockets under the hood.",              createdAt: "2024-09-04T10:00:00Z" }
];

var profiles = [
  { userId: "1", bio: "Full-stack developer and open source enthusiast.", avatar: "https://i.pravatar.cc/150?img=1", website: "https://alice.dev",   location: "San Francisco, CA" },
  { userId: "2", bio: "Backend engineer. Coffee lover.",                  avatar: "https://i.pravatar.cc/150?img=2", website: "https://bob.io",      location: "Austin, TX"        },
  { userId: "3", bio: "Passionate about clean code and good design.",     avatar: "https://i.pravatar.cc/150?img=3", website: null,                  location: "New York, NY"      },
  { userId: "4", bio: "Security researcher and GraphQL evangelist.",      avatar: "https://i.pravatar.cc/150?img=4", website: "https://diana.tech", location: "Seattle, WA"       },
  { userId: "5", bio: "Junior developer. Always learning.",               avatar: "https://i.pravatar.cc/150?img=5", website: null,                  location: "Chicago, IL"       }
];

// ---- ID counters ----
var idCounter = { user: 100, post: 200, comment: 300 };

function nextId(entity) {
  idCounter[entity] = idCounter[entity] + 1;
  return String(idCounter[entity]);
}

// --------------------------------------------------------
// Finders
// --------------------------------------------------------
function findUser(id)              { return users.find(function(u){ return u.id === id; }) || null; }
function findPost(id)              { return posts.find(function(p){ return p.id === id; }) || null; }
function findComment(id)           { return comments.find(function(c){ return c.id === id; }) || null; }
function findProfileByUser(userId){ return profiles.find(function(p){ return p.userId === userId; }) || null; }

function findPostsByAuthor(authorId)  { return posts.filter(function(p){ return p.authorId === authorId; }); }
function findCommentsByPost(postId)   { return comments.filter(function(c){ return c.postId === postId; }); }
function findCommentsByAuthor(aid)    { return comments.filter(function(c){ return c.authorId === aid; }); }

function findPostsByTag(tag) {
  return posts.filter(function(p){ return p.tags.indexOf(tag) !== -1; });
}

function searchPosts(keyword) {
  var kw = keyword.toLowerCase();
  return posts.filter(function(p) {
    return (
      p.title.toLowerCase().indexOf(kw) !== -1 ||
      p.body.toLowerCase().indexOf(kw) !== -1 ||
      p.tags.some(function(t){ return t.toLowerCase().indexOf(kw) !== -1; })
    );
  });
}

function getAllUsers()    { return users; }
function getAllPosts()    { return posts; }
function getAllComments() { return comments; }

// --------------------------------------------------------
// Mutation helpers
// --------------------------------------------------------
function addUser(data) {
  var user = {
    id:        nextId("user"),
    name:      data.name,
    email:     data.email,
    role:      data.role || "USER",
    createdAt: new Date().toISOString()
  };
  users.push(user);
  profiles.push({ userId: user.id, bio: "", avatar: null, website: null, location: null });
  return user;
}

function addPost(data) {
  var post = {
    id:        nextId("post"),
    title:     data.title,
    body:      data.body,
    authorId:  data.authorId,
    tags:      data.tags || [],
    createdAt: new Date().toISOString(),
    published: data.published !== undefined ? data.published : false
  };
  posts.push(post);
  return post;
}

function addComment(data) {
  var comment = {
    id:        nextId("comment"),
    postId:    data.postId,
    authorId:  data.authorId,
    body:      data.body,
    createdAt: new Date().toISOString()
  };
  comments.push(comment);
  return comment;
}

function updatePost(id, data) {
  var post = findPost(id);
  if (!post) return null;
  if (data.title     !== undefined) post.title     = data.title;
  if (data.body      !== undefined) post.body      = data.body;
  if (data.tags      !== undefined) post.tags      = data.tags;
  if (data.published !== undefined) post.published = data.published;
  return post;
}

function updateProfile(userId, data) {
  var profile = findProfileByUser(userId);
  if (!profile) return null;
  if (data.bio      !== undefined) profile.bio      = data.bio;
  if (data.avatar   !== undefined) profile.avatar   = data.avatar;
  if (data.website  !== undefined) profile.website  = data.website;
  if (data.location !== undefined) profile.location = data.location;
  return profile;
}

function deletePost(id) {
  var idx = posts.findIndex(function(p){ return p.id === id; });
  if (idx === -1) return false;
  posts.splice(idx, 1);
  comments = comments.filter(function(c){ return c.postId !== id; });
  return true;
}

function deleteComment(id) {
  var idx = comments.findIndex(function(c){ return c.id === id; });
  if (idx === -1) return false;
  comments.splice(idx, 1);
  return true;
}

// --------------------------------------------------------
// Pagination
// --------------------------------------------------------
function paginateArray(arr, limit, offset) {
  var start = offset || 0;
  var end   = start + (limit || arr.length);
  return {
    items:      arr.slice(start, end),
    totalCount: arr.length,
    hasMore:    end < arr.length
  };
}

// ============================================================
// RESOLVERS (inlined from resolvers.js)
// Sort helper, four wrapper functions, root resolver object.
// All db.X() calls are now just X() — same scope.
// ============================================================

// --------------------------------------------------------
// HELPER: sort an array of posts
// --------------------------------------------------------
function sortPosts(postsArray, sortField, sortOrder) {
  if (!sortField) return postsArray;

  var sorted = postsArray.slice(); // copy — never mutate source

  sorted.sort(function(a, b) {
    var valA, valB;

    switch (sortField) {
      case "TITLE":
        valA = a.title.toLowerCase();
        valB = b.title.toLowerCase();
        break;
      case "COMMENT_COUNT":
        valA = findCommentsByPost(a.id).length;
        valB = findCommentsByPost(b.id).length;
        break;
      case "CREATED_AT":
      default:
        valA = new Date(a.createdAt).getTime();
        valB = new Date(b.createdAt).getTime();
        break;
    }

    if (valA < valB) return sortOrder === "DESC" ?  1 : -1;
    if (valA > valB) return sortOrder === "DESC" ? -1 :  1;
    return 0;
  });

  return sorted;
}

// --------------------------------------------------------
// WRAPPERS — nested fields are functions; the executor
// calls them only when the client selects that field.
// --------------------------------------------------------
function wrapUser(user) {
  if (!user) return null;
  return {
    id:        user.id,
    name:      user.name,
    email:     user.email,
    role:      user.role,
    createdAt: user.createdAt,

    profile: function() {
      return wrapProfile(findProfileByUser(user.id));
    },
    posts: function() {
      return findPostsByAuthor(user.id).map(wrapPost);
    },
    comments: function() {
      return findCommentsByAuthor(user.id).map(wrapComment);
    },
    postCount: function() {
      return findPostsByAuthor(user.id).length;
    },
    commentCount: function() {
      return findCommentsByAuthor(user.id).length;
    }
  };
}

function wrapProfile(profile) {
  if (!profile) return null;
  return {
    userId:  profile.userId,
    bio:      profile.bio,
    avatar:   profile.avatar,
    website:  profile.website,
    location: profile.location,

    user: function() {
      return wrapUser(findUser(profile.userId));
    }
  };
}

function wrapPost(post) {
  if (!post) return null;
  return {
    id:        post.id,
    title:     post.title,
    body:      post.body,
    tags:      post.tags,
    createdAt: post.createdAt,
    published: post.published,

    author: function() {
      return wrapUser(findUser(post.authorId));
    },
    comments: function() {
      return findCommentsByPost(post.id).map(wrapComment);
    },
    commentCount: function() {
      return findCommentsByPost(post.id).length;
    },
    // complex: posts sharing at least one tag, deduplicated
    relatedPosts: function() {
      var seen = {};
      var related = [];
      post.tags.forEach(function(tag) {
        findPostsByTag(tag).forEach(function(p) {
          if (p.id !== post.id && !seen[p.id]) {
            seen[p.id] = true;
            related.push(p);
          }
        });
      });
      return related.map(wrapPost);
    }
  };
}

function wrapComment(comment) {
  if (!comment) return null;
  return {
    id:        comment.id,
    postId:    comment.postId,
    body:      comment.body,
    createdAt: comment.createdAt,

    author: function() {
      return wrapUser(findUser(comment.authorId));
    },
    post: function() {
      return wrapPost(findPost(comment.postId));
    }
  };
}

// --------------------------------------------------------
// ROOT RESOLVER OBJECT
//   Each key = a top-level query or mutation name.
//   Each value = function(args) the executor calls.
// --------------------------------------------------------
var resolvers = {

  // --- QUERIES ---

  user: function(args) {
    return wrapUser(findUser(args.id));
  },

  users: function() {
    return getAllUsers().map(wrapUser);
  },

  userByEmail: function(args) {
    var found = getAllUsers().find(function(u) {
      return u.email === args.email;
    });
    return wrapUser(found || null);
  },

  post: function(args) {
    return wrapPost(findPost(args.id));
  },

  // paginated + sortable post list
  posts: function(args) {
    var allPosts  = getAllPosts();
    var sorted    = sortPosts(allPosts, args.sortField, args.sortOrder || "DESC");
    var paginated = paginateArray(sorted, args.limit, args.offset);
    return {
      items:      paginated.items.map(wrapPost),
      totalCount: paginated.totalCount,
      hasMore:    paginated.hasMore
    };
  },

  postsByAuthor: function(args) {
    return findPostsByAuthor(args.authorId).map(wrapPost);
  },

  postsByTag: function(args) {
    return findPostsByTag(args.tag).map(wrapPost);
  },

  searchPosts: function(args) {
    return searchPosts(args.keyword).map(wrapPost);
  },

  comment: function(args) {
    return wrapComment(findComment(args.id));
  },

  commentsOnPost: function(args) {
    var all       = findCommentsByPost(args.postId);
    var paginated = paginateArray(all, args.limit, args.offset);
    return {
      items:      paginated.items.map(wrapComment),
      totalCount: paginated.totalCount,
      hasMore:    paginated.hasMore
    };
  },

  profile: function(args) {
    return wrapProfile(findProfileByUser(args.userId));
  },

  // complex aggregation resolver
  siteStats: function() {
    var allUsers    = getAllUsers();
    var allPosts    = getAllPosts();
    var allComments = getAllComments();

    // tag frequency map
    var tagMap = {};
    allPosts.forEach(function(p) {
      p.tags.forEach(function(t) {
        tagMap[t] = (tagMap[t] || 0) + 1;
      });
    });
    var topTags = Object.keys(tagMap).map(function(t) {
      return { tag: t, postCount: tagMap[t] };
    });
    topTags.sort(function(a, b) { return b.postCount - a.postCount; });
    topTags = topTags.slice(0, 5);

    // per-user engagement
    var topUsers = allUsers.map(function(u) {
      var pc = findPostsByAuthor(u.id).length;
      var cc = findCommentsByAuthor(u.id).length;
      return {
        user:            wrapUser(u),
        postCount:       pc,
        commentCount:    cc,
        totalEngagement: pc + cc
      };
    });
    topUsers.sort(function(a, b) { return b.totalEngagement - a.totalEngagement; });
    topUsers = topUsers.slice(0, 3);

    return {
      totalUsers:    allUsers.length,
      totalPosts:    allPosts.length,
      totalComments: allComments.length,
      topTags:       topTags,
      topUsers:      topUsers
    };
  },

  // --- MUTATIONS ---

  createUser: function(args) {
    var newUser = addUser(args.input);
    return wrapUser(newUser);
  },

  createPost: function(args) {
    if (!findUser(args.input.authorId)) {
      throw new Error("Author with id '" + args.input.authorId + "' does not exist.");
    }
    var newPost = addPost(args.input);
    return wrapPost(newPost);
  },

  updatePost: function(args) {
    if (!findPost(args.id)) {
      throw new Error("Post with id '" + args.id + "' not found.");
    }
    var updated = updatePost(args.id, args.input);
    return wrapPost(updated);
  },

  deletePost: function(args) {
    if (!findPost(args.id)) {
      throw new Error("Post with id '" + args.id + "' not found.");
    }
    return deletePost(args.id);
  },

  createComment: function(args) {
    if (!findPost(args.input.postId)) {
      throw new Error("Post with id '" + args.input.postId + "' does not exist.");
    }
    if (!findUser(args.input.authorId)) {
      throw new Error("Author with id '" + args.input.authorId + "' does not exist.");
    }
    var newComment = addComment(args.input);
    return wrapComment(newComment);
  },

  deleteComment: function(args) {
    if (!findComment(args.id)) {
      throw new Error("Comment with id '" + args.id + "' not found.");
    }
    return deleteComment(args.id);
  },

  updateProfile: function(args) {
    if (!findProfileByUser(args.userId)) {
      throw new Error("Profile for user '" + args.userId + "' not found.");
    }
    var updated = updateProfile(args.userId, args.input);
    return wrapProfile(updated);
  }
};

// ============================================================
// GraphiQL HTML – a minimal, self-contained IDE page
// ============================================================
var GRAPHIQL_HTML = [
  '<!DOCTYPE html>',
  '<html lang="en">',
  '<head>',
  '  <meta charset="utf-8" />',
  '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
  '  <title>GraphiQL – Custom GraphQL IDE</title>',
  '  <style>',
  '    * { box-sizing: border-box; margin: 0; padding: 0; }',
  '    body { font-family: "Segoe UI", system-ui, sans-serif; background: #1e1e2e; color: #cdd6f4; height: 100vh; display: flex; flex-direction: column; }',
  '    header { background: #313244; padding: 10px 20px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #45475a; }',
  '    header h1 { font-size: 18px; color: #cba6f7; letter-spacing: 1px; }',
  '    #runBtn { background: #a6e3a1; color: #1e1e2e; border: none; padding: 8px 22px; border-radius: 6px; font-size: 15px; font-weight: 700; cursor: pointer; }',
  '    #runBtn:hover { background: #c2f0bd; }',
  '    .pane-row { display: flex; flex: 1; overflow: hidden; }',
  '    .pane { flex: 1; display: flex; flex-direction: column; overflow: hidden; }',
  '    .pane-header { background: #313244; padding: 6px 14px; font-size: 13px; color: #a6adc8; border-bottom: 1px solid #45475a; }',
  '    textarea, #output { flex: 1; background: #11111b; color: #cdd6f4; padding: 16px; font-family: "JetBrains Mono", "Fira Code", monospace; font-size: 14px; resize: none; outline: none; border: none; overflow: auto; white-space: pre-wrap; }',
  '    textarea { border-right: 2px solid #45475a; }',
  '    #output { line-height: 1.6; }',
  '    .err { color: #f38ba8; }',
  '  </style>',
  '</head>',
  '<body>',
  '  <header>',
  '    <h1>&#9670; GraphiQL — Custom Engine</h1>',
  '    <button id="runBtn">&#9654; Execute</button>',
  '  </header>',
  '  <div class="pane-row">',
  '    <div class="pane">',
  '      <div class="pane-header">Query / Mutation</div>',
  '      <textarea id="queryEditor">{',
  '  posts(limit: 3, sortField: CREATED_AT, sortOrder: DESC) {',
  '    items {',
  '      id',
  '      title',
  '      published',
  '      author {',
  '        name',
  '        profile { bio, location }',
  '      }',
  '      comments { body, author { name } }',
  '      relatedPosts { id, title }',
  '    }',
  '    totalCount',
  '    hasMore',
  '  }',
  '}</textarea>',
  '    </div>',
  '    <div class="pane">',
  '      <div class="pane-header">Result</div>',
  '      <div id="output">Press Execute to run a query…</div>',
  '    </div>',
  '  </div>',
  '',
  '  <script>',
  '  (function() {',
  '    var btn    = document.getElementById("runBtn");',
  '    var editor = document.getElementById("queryEditor");',
  '    var output = document.getElementById("output");',
  '',
  '    btn.addEventListener("click", function() {',
  '      output.className = "";',
  '      output.textContent = "Sending…";',
  '      var xhr = new XMLHttpRequest();',
  '      xhr.open("POST", "/graphql", true);',
  '      xhr.setRequestHeader("Content-Type", "application/json");',
  '      xhr.onreadystatechange = function() {',
  '        if (xhr.readyState === 4) {',
  '          try {',
  '            var json = JSON.parse(xhr.responseText);',
  '            if (json.errors) {',
  '              output.className = "err";',
  '              output.textContent = JSON.stringify(json, null, 2);',
  '            } else {',
  '              output.textContent = JSON.stringify(json, null, 2);',
  '            }',
  '          } catch(e) {',
  '            output.className = "err";',
  '            output.textContent = xhr.responseText;',
  '          }',
  '        }',
  '      };',
  '      xhr.send(JSON.stringify({ query: editor.value }));',
  '    });',
  '  })();',
  '  </script>',
  '</body>',
  '</html>'
].join("\n");

// ============================================================
// Body reader – collects POST body into a string
// ============================================================
function readBody(req, callback) {
  var body = "";
  req.on("data", function(chunk) {
    body += chunk.toString();
  });
  req.on("end", function() {
    callback(body);
  });
}

// ============================================================
// Send helpers
// ============================================================
function sendJSON(res, statusCode, obj) {
  var payload = JSON.stringify(obj);
  res.writeHead(statusCode, {
    "Content-Type":   "application/json",
    "Content-Length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

function sendHTML(res, html) {
  res.writeHead(200, {
    "Content-Type":   "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html)
  });
  res.end(html);
}

function sendText(res, text) {
  res.writeHead(200, {
    "Content-Type":   "text/plain",
    "Content-Length": Buffer.byteLength(text)
  });
  res.end(text);
}

// ============================================================
// Request Handler
// ============================================================
function handleRequest(req, res) {
  var url    = req.url;
  var method = req.method;

  // --- GET / ---
  if (url === "/" && method === "GET") {
    sendText(res, "GraphQL API Server is running.\nVisit http://localhost:" + PORT + "/graphql");
    return;
  }

  // --- GET /graphql → serve GraphiQL IDE ---
  if (url === "/graphql" && method === "GET") {
    sendHTML(res, GRAPHIQL_HTML);
    return;
  }

  // --- POST /graphql → execute query ---
  if (url === "/graphql" && method === "POST") {
    readBody(req, function(body) {
      try {
        var json  = JSON.parse(body);
        var query = json.query;

        if (!query || typeof query !== "string") {
          sendJSON(res, 400, { errors: [{ message: "Must provide a 'query' string in the JSON body." }] });
          return;
        }

        // 1) Parse the query string into an AST
        var ast = parse(query);

        // 2) Execute the AST against our resolvers
        var result = execute(ast);

        // 3) Respond
        var status = result.errors ? 200 : 200; // GraphQL always 200 by convention
        sendJSON(res, status, result);

      } catch (err) {
        sendJSON(res, 400, { errors: [{ message: err.message }] });
      }
    });
    return;
  }

  // --- anything else → 404 ---
  sendJSON(res, 404, { errors: [{ message: "Not found. Use GET or POST /graphql" }] });
}

// ============================================================
// Boot
// ============================================================
var server = http.createServer(handleRequest);

server.listen(PORT, function() {
  console.log("============================================");
  console.log("   GraphQL API Server (pure Node.js)");
  console.log("   http://localhost:" + PORT + "/graphql");
  console.log("============================================");
  console.log("   GraphiQL IDE  →  GET  /graphql");
  console.log("   Execute query →  POST /graphql");
  console.log("============================================");
});

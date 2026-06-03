import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TextSqlite from "./TextSqlite.ts";

const metadata = {
    mimetype: "text/x-sqlite",
    glyph: "🗃️",
    extensions: [".sql", ".sqlite"] as const,
};

describe("TextSqlite — instantiation", () => {
    it("instantiates with metadata", () => {
        const h = new TextSqlite(metadata);
        assert.equal(h.mimetype, "text/x-sqlite");
        assert.equal(h.glyph, "🗃️");
    });
});

describe("TextSqlite — extract", () => {
    it("extracts CREATE TABLE as class + columns as fields", () => {
        const h = new TextSqlite(metadata);
        const src = [
            "CREATE TABLE users (",
            "    id INTEGER PRIMARY KEY,",
            "    name TEXT NOT NULL,",
            "    email TEXT UNIQUE,",
            "    created_at INTEGER",
            ");",
        ].join("\n");
        const syms = h.extractRaw(src);
        const t = syms.find((s) => s.name === "users" && s.kind === "class");
        assert.ok(t);
        const id = syms.find((s) => s.name === "id");
        assert.ok(id);
        assert.equal(id.kind, "field");
        const name = syms.find((s) => s.name === "name");
        assert.ok(name);
        const email = syms.find((s) => s.name === "email");
        assert.ok(email);
        const created = syms.find((s) => s.name === "created_at");
        assert.ok(created);
    });

    it("extracts CREATE VIEW as class kind", () => {
        const h = new TextSqlite(metadata);
        const src = [
            "CREATE VIEW active_users AS SELECT * FROM users WHERE deleted_at IS NULL;",
        ].join("\n");
        const syms = h.extractRaw(src);
        const v = syms.find((s) => s.name === "active_users");
        assert.ok(v);
        assert.equal(v.kind, "class");
    });

    it("extracts CREATE INDEX as field (attached to its table)", () => {
        const h = new TextSqlite(metadata);
        const src = [
            "CREATE INDEX idx_users_email ON users (email);",
            "CREATE UNIQUE INDEX idx_users_id ON users (id);",
        ].join("\n");
        const syms = h.extractRaw(src);
        const i1 = syms.find((s) => s.name === "idx_users_email");
        assert.ok(i1);
        assert.equal(i1.kind, "field");
        const i2 = syms.find((s) => s.name === "idx_users_id");
        assert.ok(i2);
    });

    it("extracts CREATE TRIGGER as method", () => {
        const h = new TextSqlite(metadata);
        const src = [
            "CREATE TRIGGER touch_updated_at AFTER UPDATE ON users",
            "BEGIN",
            "    UPDATE users SET updated_at = unixepoch() WHERE id = NEW.id;",
            "END;",
        ].join("\n");
        const syms = h.extractRaw(src);
        const t = syms.find((s) => s.name === "touch_updated_at");
        assert.ok(t);
        assert.equal(t.kind, "method");
    });

    it("extracts CREATE VIRTUAL TABLE as class kind", () => {
        const h = new TextSqlite(metadata);
        const src = [
            "CREATE VIRTUAL TABLE docs_fts USING fts5(title, body);",
        ].join("\n");
        const syms = h.extractRaw(src);
        const t = syms.find((s) => s.name === "docs_fts");
        assert.ok(t);
        assert.equal(t.kind, "class");
    });

    it("handles quoted identifiers (strips quotes for outline)", () => {
        const h = new TextSqlite(metadata);
        const src = [
            'CREATE TABLE "weird-name" ("id" INTEGER, "first name" TEXT);',
        ].join("\n");
        const syms = h.extractRaw(src);
        assert.ok(syms.find((s) => s.name === "weird-name"));
        assert.ok(syms.find((s) => s.name === "id"));
        assert.ok(syms.find((s) => s.name === "first name"));
    });

    it("excludes SELECT/INSERT/UPDATE/DELETE/PRAGMA (data manipulation, not declarations)", () => {
        const h = new TextSqlite(metadata);
        const src = [
            "PRAGMA foreign_keys = ON;",
            "BEGIN;",
            "INSERT INTO users (id, name) VALUES (1, 'a');",
            "UPDATE users SET name = 'b' WHERE id = 1;",
            "SELECT * FROM users;",
            "DELETE FROM users;",
            "COMMIT;",
            "CREATE TABLE t (id INTEGER);",
        ].join("\n");
        const syms = h.extractRaw(src);
        const names = syms.map((s) => s.name);
        assert.deepEqual(names.toSorted(), ["id", "t"]);
    });

    it("returns empty array for empty input", () => {
        const h = new TextSqlite(metadata);
        assert.deepEqual(h.extractRaw(""), []);
    });

    it("does not throw on malformed source (graceful)", () => {
        const h = new TextSqlite(metadata);
        assert.doesNotThrow(() => h.extractRaw("CREATE TABLE ( broken"));
        assert.doesNotThrow(() => h.extractRaw("@@ totally bogus"));
    });
});

describe("TextSqlite — framework integration", () => {
    it("renders extracted hierarchy via format()", async () => {
        const h = new TextSqlite(metadata);
        const out = await h.symbolsRaw("CREATE TABLE answers (id INTEGER);");
        assert.ok(out.includes("class answers"));
        assert.ok(out.includes("field id"));
    });

    it("jsonpath dispatches against the deep-json ANTLR parse tree (issue #10)", async () => {
        // Every ANTLR deep tree has a root with a `type` field — verify
        // jsonpath reaches it via the deep-channel dispatch.
        const h = new TextSqlite(metadata);
        const roots = await h.query("class Probe {}", "jsonpath", "$.type");
        assert.equal(roots.length, 1);
        assert.equal(typeof roots[0].matched, "string");
    });
});

// Real-world smoke against a representative SQLite migration script —
// the kind of code agents see in Rails / Drizzle / Prisma / homegrown
// migration projects.
describe("TextSqlite — real-world smoke (migration-shape)", () => {
    const SRC = [
        "PRAGMA foreign_keys = ON;",
        "",
        "CREATE TABLE users (",
        "    id INTEGER PRIMARY KEY AUTOINCREMENT,",
        "    email TEXT NOT NULL UNIQUE,",
        "    name TEXT NOT NULL,",
        "    created_at INTEGER NOT NULL DEFAULT (unixepoch()),",
        "    updated_at INTEGER NOT NULL DEFAULT (unixepoch())",
        ");",
        "",
        "CREATE INDEX idx_users_email ON users (email);",
        "",
        "CREATE TABLE posts (",
        "    id INTEGER PRIMARY KEY AUTOINCREMENT,",
        "    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,",
        "    title TEXT NOT NULL,",
        "    body TEXT,",
        "    published_at INTEGER",
        ");",
        "",
        "CREATE INDEX idx_posts_user_id ON posts (user_id);",
        "CREATE INDEX idx_posts_published_at ON posts (published_at);",
        "",
        "CREATE VIEW active_posts AS",
        "    SELECT p.* FROM posts p WHERE p.published_at IS NOT NULL;",
        "",
        "CREATE TRIGGER touch_users_updated_at AFTER UPDATE ON users",
        "BEGIN",
        "    UPDATE users SET updated_at = unixepoch() WHERE id = NEW.id;",
        "END;",
        "",
        "CREATE VIRTUAL TABLE posts_fts USING fts5(title, body, content=posts);",
    ].join("\n");

    it("surfaces tables + columns + indexes + view + trigger + virtual table", () => {
        const h = new TextSqlite(metadata);
        const syms = h.extractRaw(SRC);
        const names = new Set(syms.map((s) => s.name));

        assert.ok(names.has("users"));
        assert.ok(names.has("posts"));
        assert.ok(names.has("active_posts"));
        assert.ok(names.has("posts_fts"));

        assert.ok(names.has("email"));
        assert.ok(names.has("title"));
        assert.ok(names.has("body"));
        assert.ok(names.has("user_id"));

        assert.ok(names.has("idx_users_email"));
        assert.ok(names.has("idx_posts_user_id"));
        assert.ok(names.has("idx_posts_published_at"));

        assert.ok(names.has("touch_users_updated_at"));
    });

    it("kind discrimination across the migration", () => {
        const h = new TextSqlite(metadata);
        const syms = h.extractRaw(SRC);
        const byNameKind = new Map(syms.map((s) => [`${s.name}:${s.kind}`, s]));
        assert.ok(byNameKind.has("users:class"));
        assert.ok(byNameKind.has("posts:class"));
        assert.ok(byNameKind.has("active_posts:class"));
        assert.ok(byNameKind.has("posts_fts:class"));
        assert.ok(byNameKind.has("email:field"));
        assert.ok(byNameKind.has("idx_posts_user_id:field"));
        assert.ok(byNameKind.has("touch_users_updated_at:method"));
    });
});

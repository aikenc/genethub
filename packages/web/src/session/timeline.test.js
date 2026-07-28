import { describe, expect, it } from "vitest";
import { apply, applySequenced, assistantText, emptyTimeline } from "./timeline";
function run(events) {
    return events.reduce(apply, emptyTimeline());
}
const bubble = (id, text) => ({
    type: "assistantMessage",
    id,
    text,
});
describe("the session timeline", () => {
    it("streams a reply into one bubble rather than one per token", () => {
        const state = run([
            { type: "turnStarted", turnId: "t1" },
            { type: "item", turnId: "t1", item: bubble("a1", "") },
            { type: "itemDelta", turnId: "t1", itemId: "a1", delta: { kind: "text", delta: "he" } },
            { type: "itemDelta", turnId: "t1", itemId: "a1", delta: { kind: "text", delta: "llo" } },
        ]);
        expect(state.items).toHaveLength(1);
        expect(assistantText(state)).toBe("hello");
    });
    it("replaces a bubble when the final version arrives instead of showing it twice", () => {
        const state = run([
            { type: "item", turnId: "t1", item: bubble("a1", "") },
            { type: "itemDelta", turnId: "t1", itemId: "a1", delta: { kind: "text", delta: "partial" } },
            { type: "item", turnId: "t1", item: bubble("a1", "the whole reply") },
        ]);
        expect(state.items).toHaveLength(1);
        expect(assistantText(state)).toBe("the whole reply");
    });
    it("moves a tool call through its states in place", () => {
        const call = {
            type: "toolCall",
            id: "c1",
            name: "bash",
            status: "pending",
            detail: { kind: "shell", command: "ls", output: "", exitCode: undefined },
        };
        const running = apply(apply(emptyTimeline(), { type: "item", turnId: "t1", item: call }), {
            type: "itemDelta",
            turnId: "t1",
            itemId: "c1",
            delta: { kind: "toolStatus", status: "running" },
        });
        expect(running.items).toHaveLength(1);
        const item = running.items[0];
        expect(item.type === "toolCall" && item.status).toBe("running");
        // No new detail came with the status, so the command must survive.
        expect(item.type === "toolCall" && item.detail.kind === "shell" && item.detail.command).toBe("ls");
    });
    it("takes the fuller detail when a status delta carries one", () => {
        const call = {
            type: "toolCall",
            id: "c1",
            name: "bash",
            status: "running",
            detail: { kind: "shell", command: "ls", output: "", exitCode: undefined },
        };
        const done = apply(apply(emptyTimeline(), { type: "item", turnId: "t1", item: call }), {
            type: "itemDelta",
            turnId: "t1",
            itemId: "c1",
            delta: {
                kind: "toolStatus",
                status: "ok",
                detail: { kind: "shell", command: "ls", output: "a\nb", exitCode: 0 },
            },
        });
        const item = done.items[0];
        expect(item.type === "toolCall" && item.detail.kind === "shell" && item.detail.output).toBe("a\nb");
    });
    it("ignores a delta for something it has never seen", () => {
        const state = apply(emptyTimeline(), {
            type: "itemDelta",
            turnId: "t1",
            itemId: "ghost",
            delta: { kind: "text", delta: "..." },
        });
        expect(state.items).toEqual([]);
    });
    it("clears the previous failure when a new turn starts", () => {
        const state = run([
            { type: "turnStarted", turnId: "t1" },
            { type: "turnFailed", turnId: "t1", error: { code: "upstream", message: "boom" } },
            { type: "turnStarted", turnId: "t2" },
        ]);
        expect(state.lastError).toBeNull();
        expect(state.status).toBe("running");
        expect(state.activeTurn).toBe("t2");
    });
    it("leaves a failure visible until something replaces it", () => {
        const state = run([
            { type: "turnStarted", turnId: "t1" },
            { type: "turnFailed", turnId: "t1", error: { code: "missingCredentials", message: "no key" } },
        ]);
        expect(state.lastError?.code).toBe("missingCredentials");
        expect(state.activeTurn).toBeNull();
        expect(state.status).toBe("idle");
    });
    it("shows an approval request and takes it down once it is answered", () => {
        const request = {
            id: "p1",
            title: "run this?",
            options: [{ id: "yes", label: "Allow", kind: "allowOnce" }],
        };
        const asked = apply(emptyTimeline(), { type: "permissionRequested", request });
        expect(asked.pendingPermission?.id).toBe("p1");
        const answered = apply(asked, {
            type: "permissionResolved",
            requestId: "p1",
            outcome: { outcome: "selected", optionId: "yes" },
        });
        expect(answered.pendingPermission).toBeNull();
    });
    it("does not clear an approval that a different request resolved", () => {
        const request = {
            id: "p1",
            title: "run this?",
            options: [],
        };
        const asked = apply(emptyTimeline(), { type: "permissionRequested", request });
        const other = apply(asked, {
            type: "permissionResolved",
            requestId: "p-other",
            outcome: { outcome: "canceled" },
        });
        expect(other.pendingPermission?.id).toBe("p1");
    });
    it("refuses to go backwards when a replayed event is older than what it has", () => {
        let state = emptyTimeline();
        state = applySequenced(state, {
            seq: 5,
            sessionId: "s1",
            event: { type: "item", turnId: "t1", item: bubble("a1", "newer") },
        });
        state = applySequenced(state, {
            seq: 3,
            sessionId: "s1",
            event: { type: "item", turnId: "t1", item: bubble("a2", "older") },
        });
        expect(state.items.map((item) => item.id)).toEqual(["a1"]);
        expect(state.seq).toBe(5);
    });
});

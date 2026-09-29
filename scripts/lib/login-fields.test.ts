import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright-core";
import { loginFieldCandidates } from "./login-fields.ts";

type ElementFixture = {
  tag: "input" | "button"; type?: string; label?: string; placeholder?: string;
  name?: string; id?: string; accessibleName?: string; visible?: boolean;
};

// Browser-free semantic fixture: model locator union/intersection and visibility.
// The elements intentionally have no input-value property.
function fakePage(elements: ElementFixture[]): Page {
  class Selection {
    readonly elements: ElementFixture[];
    constructor(elements: ElementFixture[]) { this.elements = elements; }
    or(other: Selection) { return new Selection([...new Set([...this.elements, ...other.elements])]); }
    and(other: Selection) { return new Selection(this.elements.filter((element) => other.elements.includes(element))); }
    filter() { return new Selection(this.elements.filter((element) => element.visible !== false)); }
    async count() { return this.elements.length; }
  }
  const select = (predicate: (element: ElementFixture) => boolean) => new Selection(elements.filter(predicate));
  return {
    getByLabel: (name: RegExp) => select((element) => name.test(element.label ?? element.accessibleName ?? "")),
    getByPlaceholder: (name: RegExp) => select((element) => name.test(element.placeholder ?? "")),
    getByRole: (role: string, options: { name: RegExp }) => select((element) => {
      const actualRole = element.tag === "button" || element.type === "submit" ? "button" :
        element.tag === "input" && [undefined, "text", "email"].includes(element.type) ? "textbox" : "";
      return role === actualRole && options.name.test(element.accessibleName ?? element.label ?? "");
    }),
    locator: (selector: string) => select((element) => selector.split(", ").some((part) => {
      if (element.tag !== "input") return false;
      if (part === "input:not([type])") return element.type === undefined;
      const match = /^input\[(type|name|id)="([^"]+)" i\]$/.exec(part);
      assert.ok(match, "fixture supports only the ordinary input-attribute selectors used here");
      const key = match[1] as "type" | "name" | "id";
      return element[key]?.toLowerCase() === match[2].toLowerCase();
    })),
  } as unknown as Page;
}

async function counts(elements: ElementFixture[]) {
  const fields = loginFieldCandidates(fakePage(elements));
  return { username: await fields.username.count(), password: await fields.password.count(), submit: await fields.login.count() };
}
const password: ElementFixture = { tag: "input", type: "password" };
const login: ElementFixture = { tag: "button", accessibleName: "Log in" };

test("normal email and password types need no exact placeholder", async () => {
  assert.deepEqual(await counts([{ tag: "input", type: "email" }, password, login]), { username: 1, password: 1, submit: 1 });
});

test("username placeholder variants use semantic words", async () => {
  for (const placeholder of ["Enter your registered email address", "Email / Username", "Your user name", "Enter your active Email ID / Username"]) {
    assert.equal((await counts([{ tag: "input", type: "text", placeholder }, password, login])).username, 1);
  }
});

test("label, accessible name and clear name/id identifiers identify username fields", async () => {
  for (const cue of [{ label: "Email address" }, { accessibleName: "Username" }, { name: "email" }, { id: "loginUsername" }]) {
    assert.equal((await counts([{ tag: "input", type: "text", ...cue }, password, login])).username, 1);
  }
});

test("union deduplicates one input matching multiple cues", async () => {
  assert.equal((await counts([{ tag: "input", type: "email", label: "Email", name: "email", placeholder: "Email address" }])).username, 1);
});

test("different semantic candidates remain ambiguous, including hidden-field filtering", async () => {
  const elements: ElementFixture[] = [{ tag: "input", type: "email" }, { tag: "input", label: "Username" }];
  assert.equal((await counts(elements)).username, 2);
  elements[1].visible = false;
  assert.equal((await counts(elements)).username, 1);
});

test("unrelated or missing username inputs are not guessed", async () => {
  assert.equal((await counts([{ tag: "input", name: "search", placeholder: "Search jobs" }, password, login])).username, 0);
  assert.equal((await counts([{ tag: "input", type: "hidden", name: "email" }])).username, 0);
});

test("password candidates must be visible password inputs", async () => {
  assert.equal((await counts([password])).password, 1);
  assert.equal((await counts([password, { ...password, label: "Confirm password" }])).password, 2);
  assert.equal((await counts([{ ...password, visible: false }, { tag: "input", type: "text", label: "Password" }])).password, 0);
});

test("submit accessible names accept Login and Log in, exclude other actions", async () => {
  for (const accessibleName of ["Login", "Log in", " LOGIN "]) {
    assert.equal((await counts([{ tag: "button", accessibleName }])).submit, 1);
  }
  assert.equal((await counts([
    { tag: "button", accessibleName: "Login with Google" }, { tag: "button", accessibleName: "Register" },
    { ...login, visible: false },
  ])).submit, 0);
  assert.equal((await counts([login, { ...login }])).submit, 2);
});


test("exact visible Naukri controls match when username uses type=text", async () => {
  assert.deepEqual(await counts([
    { tag: "input", type: "text", label: "Email ID / Username", placeholder: "Enter Email ID / Username" },
    { tag: "input", type: "password", label: "Password", placeholder: "Enter Password" },
    { tag: "button", accessibleName: "Login" },
  ]), { username: 1, password: 1, submit: 1 });
  assert.equal((await counts([{ tag: "input", type: "text", placeholder: "Enter Email ID / Username" }])).username, 1);
});

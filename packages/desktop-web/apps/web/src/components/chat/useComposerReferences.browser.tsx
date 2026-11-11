// Typing must not write the composer draft store when the prompt filters keep every
// skill and mention reference: those no-op writes queued a render per keystroke and
// a fast input burst then tripped React's "maximum update depth" guard.

import { ThreadId } from "@synara/contracts";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useComposerReferences } from "./useComposerReferences";

const threadId = ThreadId.makeUnsafe("thread-references");
const skills = [{ name: "check-code", path: "/skills/check-code" }];

function Probe({ prompt }: { prompt: string }) {
  useComposerReferences({
    threadId,
    selectedProvider: "claudeAgent",
    prompt,
    composerSkills: skills,
    composerMentions: [],
  });
  return <span>{prompt}</span>;
}

it("does not rewrite unchanged references while the prompt changes", async () => {
  const setSkills = vi.fn();
  const setMentions = vi.fn();
  useComposerDraftStore.setState({ setSkills, setMentions });

  const screen = await render(<Probe prompt="$check-code a" />);
  await expect.element(screen.getByText("$check-code a")).toBeVisible();
  const skillWrites = setSkills.mock.calls.length;
  const mentionWrites = setMentions.mock.calls.length;

  for (const prompt of ["$check-code ab", "$check-code abc", "$check-code abcd"]) {
    await screen.rerender(<Probe prompt={prompt} />);
    await expect.element(screen.getByText(prompt)).toBeVisible();
  }

  expect(setSkills).toHaveBeenCalledTimes(skillWrites);
  expect(setMentions).toHaveBeenCalledTimes(mentionWrites);
});

it("still drops a skill whose reference was deleted from the prompt", async () => {
  const setSkills = vi.fn();
  useComposerDraftStore.setState({ setSkills, setMentions: vi.fn() });

  const screen = await render(<Probe prompt="$check-code go" />);
  await expect.element(screen.getByText("$check-code go")).toBeVisible();
  await screen.rerender(<Probe prompt="go" />);
  await expect.element(screen.getByText("go")).toBeVisible();

  expect(setSkills).toHaveBeenLastCalledWith(threadId, []);
});

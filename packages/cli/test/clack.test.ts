import { beforeEach, describe, expect, it, vi } from "vitest";

const clack = vi.hoisted(() => ({
  cancel: vi.fn(),
  confirm: vi.fn(async (_options: unknown) => true),
  intro: vi.fn(),
  isCancel: vi.fn(() => false),
  log: {
    message: vi.fn()
  },
  outro: vi.fn(),
  password: vi.fn(async (_options: unknown) => "secret"),
  select: vi.fn(async (_options: unknown) => "selected"),
  text: vi.fn(async (_options: unknown) => "value")
}));

vi.mock("@clack/prompts", () => clack);

import { createClackPromptAdapter } from "../src/ui/clack.js";

type ClackStringOptions = {
  validate?: (value: string | undefined) => string | Error | undefined;
};

describe("Clack prompt adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes Clack's missing text value before running an OpenTag validator", async () => {
    const prompts = createClackPromptAdapter();

    await prompts.text({
      message: "Project path",
      validate(value) {
        return value.trim() ? undefined : "Project path is required";
      }
    });

    const options = clack.text.mock.calls[0]![0] as ClackStringOptions;
    expect(options.validate?.(undefined)).toBe("Project path is required");
    expect(options.validate?.(" /tmp/project ")).toBeUndefined();
  });

  it("normalizes Clack's missing password value before running an OpenTag validator", async () => {
    const prompts = createClackPromptAdapter();

    await prompts.password({
      message: "App secret",
      validate(value) {
        return value.length > 0 ? undefined : "App secret is required";
      }
    });

    const options = clack.password.mock.calls[0]![0] as ClackStringOptions;
    expect(options.validate?.(undefined)).toBe("App secret is required");
    expect(options.validate?.("secret")).toBeUndefined();
  });
});

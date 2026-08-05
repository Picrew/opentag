import * as p from "@clack/prompts";
import type { PromptAdapter, PromptOption } from "./prompts.js";

function cancelled(): never {
  p.cancel("OpenTag setup cancelled.");
  process.exit(0);
}

function unwrapPromptResult<Value>(value: Value | symbol): Value {
  if (p.isCancel(value)) {
    cancelled();
  }
  return value;
}

type ClackStringOption<Value extends string> = {
  value: Value;
  label: string;
  hint?: string;
};

function clackOptions<Value extends string>(options: Array<PromptOption<Value>>): Array<ClackStringOption<Value>> {
  return options.map((option) => {
    const clackOption: ClackStringOption<Value> = {
      value: option.value,
      label: option.label
    };
    return option.hint ? { ...clackOption, hint: option.hint } : clackOption;
  });
}

function clackValidation(validate: ((value: string) => string | undefined) | undefined): {
  validate?: (value: string | undefined) => string | undefined;
} {
  return validate
    ? {
        validate(value) {
          return validate(value ?? "");
        }
      }
    : {};
}

export function createClackPromptAdapter(): PromptAdapter {
  return {
    intro(message) {
      p.intro(message);
    },
    outro(message) {
      p.outro(message);
    },
    note(message) {
      p.log.message(message);
    },
    async select<Value extends string>(input: {
      message: string;
      options: Array<PromptOption<Value>>;
      initialValue?: Value;
    }): Promise<Value> {
      const selected = unwrapPromptResult(
        await p.select<string>({
          message: input.message,
          options: clackOptions(input.options),
          ...(input.initialValue ? { initialValue: input.initialValue } : {})
        })
      );
      return selected as Value;
    },
    async text(input) {
      const { validate, ...options } = input;
      return unwrapPromptResult(await p.text({ ...options, ...clackValidation(validate) }));
    },
    async password(input) {
      const { validate, ...options } = input;
      return unwrapPromptResult(await p.password({ ...options, ...clackValidation(validate), mask: "*" }));
    },
    async confirm(input) {
      return unwrapPromptResult(await p.confirm(input));
    }
  };
}

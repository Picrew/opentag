import type { OpenTagCommand } from "@opentag/core";

export type LarkInteractionMode = "chat" | "task";

export type LarkInteractionDecision = {
  mode: LarkInteractionMode;
  replyInThread: boolean;
  reason: string;
};

const CHAT_OVERRIDE = /^(?:\/chat\b|chat\s*[:：]|问答\s*[:：]|只回答\b|只需回答\b|不要执行\b|不要修改\b)/iu;
const TASK_OVERRIDE = /^(?:\/task\b|task\s*[:：]|任务\s*[:：])/iu;

const ENGLISH_TASK_ACTION = /\b(?:build|change|commit|configure|create|debug|delete|deploy|execute|fix|implement|install|investigate|migrate|modify|open\s+(?:a\s+)?pr|publish|push|refactor|release|remove|review|run|ship|test|troubleshoot|update|upgrade|write)\b/iu;
const CHINESE_TASK_ACTION = /(?:实现|开发|写(?:一份|一个|代码|程序|脚本|文档)|编码|修改|改一下|修复|重构|提交|推送|部署|发布|上线|回滚|创建|新建|删除|移除|配置|安装|升级|迁移|运行|执行|跑(?:一下)?(?:测试|脚本|命令|程序)?|测试(?:一下)?|验证(?:一下)?|排查|调试|审查|代码审查|查(?:一下)?(?:日志|进程|故障)|看(?:一下)?(?:日志|进程))/u;

const EXPLICIT_TASK_INTENTS = new Set<OpenTagCommand["intent"]>([
  "fix",
  "review",
  "investigate",
  "run"
]);

/**
 * Choose the source UX before dispatching a run.
 *
 * This is intentionally deterministic and conservative: natural questions stay
 * in the channel, while explicit execution requests become asynchronous tasks.
 * A reply that already belongs to a Feishu thread always stays in that thread.
 */
export function classifyLarkInteraction(input: {
  text: string;
  command: OpenTagCommand;
  isThreadReply?: boolean;
}): LarkInteractionDecision {
  const text = input.text.trim();
  let mode: LarkInteractionMode;
  let reason: string;

  if (CHAT_OVERRIDE.test(text)) {
    mode = "chat";
    reason = "explicit_chat_override";
  } else if (TASK_OVERRIDE.test(text)) {
    mode = "task";
    reason = "explicit_task_override";
  } else if (EXPLICIT_TASK_INTENTS.has(input.command.intent)) {
    mode = "task";
    reason = `explicit_${input.command.intent}_intent`;
  } else if (input.command.parsed?.executorHint) {
    mode = "task";
    reason = "explicit_executor_hint";
  } else if ((input.command.parsed?.requestedScopes.length ?? 0) > 0) {
    mode = "task";
    reason = "explicit_permission_scope";
  } else if (ENGLISH_TASK_ACTION.test(text) || CHINESE_TASK_ACTION.test(text)) {
    mode = "task";
    reason = "execution_language";
  } else {
    mode = "chat";
    reason = "conversational_default";
  }

  return {
    mode,
    replyInThread: Boolean(input.isThreadReply) || mode === "task",
    reason
  };
}

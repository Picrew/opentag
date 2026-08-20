import {
  createFinalSummaryPresentation,
  createRunStatusPresentation,
  platformCapabilityForProvider,
  renderOpenTagPresentationPlainText,
  shouldDeliverProgressPresentation,
  shouldDeliverRunStatusPresentation,
  type ActionReceiptContext,
  type OpenTagActionReceiptPresentation,
  type OpenTagApprovalPromptPresentation,
  type OpenTagDoctorSummaryPresentation,
  type OpenTagFinalSummaryPresentation,
  type OpenTagPresentation,
  type OpenTagRunResult,
  type OpenTagRunStatusPresentation,
  type OpenTagSourceThreadStatusPresentation
} from "@opentag/core";
import { renderAcknowledgement, renderFinalSummaryPresentation, renderProgress } from "@opentag/github";
import {
  renderAcknowledgement as renderGitLabAcknowledgement,
  renderFinalSummaryPresentation as renderGitLabFinalSummaryPresentation,
  renderProgress as renderGitLabProgress
} from "@opentag/gitlab";
import {
  createLarkActionReceiptCard,
  createLarkApprovalPromptCard,
  createLarkDoctorSummaryCard,
  createLarkFinalSummaryCard,
  createLarkRunStatusCard,
  createLarkSourceThreadStatusCard,
  renderLarkActionReceiptPresentation,
  renderLarkApprovalPrompt,
  renderLarkFinalSummaryPresentation,
  renderLarkRunStatusPresentation
} from "@opentag/lark";
import {
  renderAcknowledgement as renderLinearAcknowledgement,
  renderFinalSummaryPresentation as renderLinearFinalSummaryPresentation,
  renderProgress as renderLinearProgress
} from "@opentag/linear";
import {
  createSlackActionReceiptBlocks,
  createSlackApprovalPromptBlocks,
  createSlackDoctorSummaryBlocks,
  createSlackFinalSummaryBlocks,
  createSlackRunStatusBlocks,
  createSlackSourceThreadStatusBlocks,
  markdownToSlackMrkdwn,
  renderSlackActionReceiptPresentation,
  renderSlackApprovalPrompt,
  renderSlackAcknowledgement,
  renderSlackFinalSummaryPresentation,
  renderSlackRunStatusPresentation,
  type SlackBlock
} from "@opentag/slack";
import {
  createTelegramFinalSummaryReplyMarkup,
  createTelegramMessageRich,
  createTelegramRunStatusReplyMarkup,
  renderTelegramAcknowledgement,
  renderTelegramFinalSummaryPresentation,
  renderTelegramProgress
} from "@opentag/telegram";
export type LarkRenderLocale = "en-US" | "zh-CN";

export type PresentedProviderBody = { body: string; blocks?: SlackBlock[]; rich?: { provider: string; payload: unknown } };

export type ProviderPresentation = {
  shouldDeliverAcknowledgement(provider: string): boolean;
  shouldDeliverStatusUpdate(provider: string): boolean;
  shouldDeliverRunStatusUpdate?(input: { provider: string; state: OpenTagRunStatusPresentation["state"] }): boolean;
  shouldDeliverProgress(provider: string): boolean;
  runStatusPresentation(input: {
    runId: string;
    state: OpenTagRunStatusPresentation["state"];
    message?: string;
    nextAction?: string;
    detailVisibility?: OpenTagRunStatusPresentation["detailVisibility"];
  }): OpenTagRunStatusPresentation;
  acknowledgementPresentation(input: { runId: string }): OpenTagRunStatusPresentation;
  progressPresentation(input: { runId: string; message: string }): OpenTagRunStatusPresentation;
  finalPresentation(input: { result: OpenTagRunResult; runId?: string; receiptContext?: ActionReceiptContext }): OpenTagFinalSummaryPresentation;
  render(input: { provider: string; presentation: OpenTagPresentation; larkRenderLocale?: LarkRenderLocale }): PresentedProviderBody;
  acknowledgement(input: { provider: string; runId: string }): string;
  runStatus(input: {
    provider: string;
    runId: string;
    state: OpenTagRunStatusPresentation["state"];
    message?: string;
    nextAction?: string;
    detailVisibility?: OpenTagRunStatusPresentation["detailVisibility"];
    larkRenderLocale?: LarkRenderLocale;
  }): PresentedProviderBody;
  progress(input: { provider: string; runId: string; message: string }): string;
  final(input: {
    provider: string;
    result: OpenTagRunResult;
    runId?: string;
    receiptContext?: ActionReceiptContext;
    larkRenderLocale?: LarkRenderLocale;
  }): PresentedProviderBody;
};

function renderRunStatus(provider: string, presentation: OpenTagRunStatusPresentation, options: { larkRenderLocale?: LarkRenderLocale } = {}): PresentedProviderBody {
  const canRenderRich = supportsRichPresentation(provider);
  if (canRenderRich && provider === "slack") {
    return {
      body: renderSlackRunStatusPresentation(presentation),
      blocks: createSlackRunStatusBlocks(presentation)
    };
  }
  if (canRenderRich && provider === "lark") {
    const larkOptions = options.larkRenderLocale ? { locale: options.larkRenderLocale } : {};
    return {
      body: renderLarkRunStatusPresentation(presentation, larkOptions),
      rich: {
        provider: "lark",
        payload: createLarkRunStatusCard(presentation, larkOptions)
      }
    };
  }

  if (presentation.state === "received") {
    if (provider === "slack") {
      return { body: renderSlackAcknowledgement(presentation.runId) };
    }
    if (provider === "telegram") {
      return {
        body: renderTelegramAcknowledgement(presentation.runId),
        rich: createTelegramMessageRich({ replyMarkup: createTelegramRunStatusReplyMarkup(presentation.runId) })
      };
    }
    if (provider === "gitlab") {
      return { body: renderGitLabAcknowledgement(presentation.runId) };
    }
    if (provider === "linear") {
      return { body: renderLinearAcknowledgement(presentation.runId) };
    }
    return { body: renderAcknowledgement(presentation.runId) };
  }

  const message = presentation.message ?? presentation.nextAction ?? presentation.state;
  if (provider === "telegram") {
    return {
      body: renderTelegramProgress(message, { runId: presentation.runId }),
      rich: createTelegramMessageRich({ replyMarkup: createTelegramRunStatusReplyMarkup(presentation.runId) })
    };
  }
  if (provider === "gitlab") {
    return { body: renderGitLabProgress({ runId: presentation.runId, message }) };
  }
  if (provider === "linear") {
    return { body: renderLinearProgress({ runId: presentation.runId, message }) };
  }
  return { body: renderProgress({ runId: presentation.runId, message }) };
}

function supportsRichPresentation(provider: string): boolean {
  return platformCapabilityForProvider(provider)?.supportsRichPresentation === true;
}

function renderFinalSummary(provider: string, presentation: OpenTagFinalSummaryPresentation, options: { larkRenderLocale?: LarkRenderLocale } = {}): PresentedProviderBody {
  const canRenderRich = supportsRichPresentation(provider);
  if (canRenderRich && provider === "slack") {
    return {
      body: renderSlackFinalSummaryPresentation(presentation),
      blocks: createSlackFinalSummaryBlocks(presentation)
    };
  }
  if (canRenderRich && provider === "lark") {
    const larkOptions = options.larkRenderLocale ? { locale: options.larkRenderLocale } : {};
    const renderFinalSummaryWithOptions = renderLarkFinalSummaryPresentation as (
      presentation: OpenTagFinalSummaryPresentation,
      options?: { locale?: LarkRenderLocale }
    ) => string;
    const createFinalSummaryCardWithOptions = createLarkFinalSummaryCard as (
      presentation: OpenTagFinalSummaryPresentation,
      options?: { locale?: LarkRenderLocale }
    ) => ReturnType<typeof createLarkFinalSummaryCard>;
    return {
      body: renderFinalSummaryWithOptions(presentation, larkOptions),
      rich: {
        provider: "lark",
        payload: createFinalSummaryCardWithOptions(presentation, larkOptions)
      }
    };
  }
  if (provider === "telegram") {
    const replyMarkup = createTelegramFinalSummaryReplyMarkup(presentation);
    return {
      body: renderTelegramFinalSummaryPresentation(presentation),
      rich: createTelegramMessageRich({
        ...(replyMarkup ? { replyMarkup } : {})
      })
    };
  }
  if (provider === "gitlab") {
    return { body: renderGitLabFinalSummaryPresentation(presentation) };
  }
  if (provider === "linear") {
    return { body: renderLinearFinalSummaryPresentation(presentation) };
  }
  return { body: renderFinalSummaryPresentation(presentation) };
}

function renderDoctorSummary(provider: string, presentation: OpenTagDoctorSummaryPresentation): PresentedProviderBody {
  const body = renderOpenTagPresentationPlainText(presentation);
  const canRenderRich = supportsRichPresentation(provider);
  if (canRenderRich && provider === "slack") {
    return {
      body: markdownToSlackMrkdwn(body),
      blocks: createSlackDoctorSummaryBlocks(presentation)
    };
  }
  if (canRenderRich && provider === "lark") {
    return {
      body,
      rich: {
        provider: "lark",
        payload: createLarkDoctorSummaryCard(presentation)
      }
    };
  }
  return { body };
}

function renderSourceThreadStatus(provider: string, presentation: OpenTagSourceThreadStatusPresentation): PresentedProviderBody {
  const body = renderOpenTagPresentationPlainText(presentation);
  const canRenderRich = supportsRichPresentation(provider);
  if (canRenderRich && provider === "slack") {
    return {
      body: markdownToSlackMrkdwn(body),
      blocks: createSlackSourceThreadStatusBlocks(presentation)
    };
  }
  if (canRenderRich && provider === "lark") {
    return {
      body,
      rich: {
        provider: "lark",
        payload: createLarkSourceThreadStatusCard(presentation)
      }
    };
  }
  return { body };
}

function renderActionReceipt(provider: string, presentation: OpenTagActionReceiptPresentation, options: { larkRenderLocale?: LarkRenderLocale } = {}): PresentedProviderBody {
  const body =
    provider === "slack"
      ? renderSlackActionReceiptPresentation(presentation)
      : provider === "lark"
        ? renderLarkActionReceiptPresentation(presentation)
        : renderOpenTagPresentationPlainText(presentation);
  const canRenderRich = supportsRichPresentation(provider);
  if (canRenderRich && provider === "slack") {
    return {
      body,
      blocks: createSlackActionReceiptBlocks(presentation)
    };
  }
  if (canRenderRich && provider === "lark") {
    return {
      body,
      rich: {
        provider: "lark",
        payload: createLarkActionReceiptCard(presentation)
      }
    };
  }
  return { body };
}

function renderApprovalPrompt(provider: string, presentation: OpenTagApprovalPromptPresentation): PresentedProviderBody {
  if (supportsRichPresentation(provider) && provider === "slack") {
    return { body: renderSlackApprovalPrompt(presentation), blocks: createSlackApprovalPromptBlocks(presentation) };
  }
  if (supportsRichPresentation(provider) && provider === "lark") {
    return {
      body: renderLarkApprovalPrompt(presentation),
      rich: { provider: "lark", payload: createLarkApprovalPromptCard(presentation) }
    };
  }
  return { body: renderOpenTagPresentationPlainText(presentation) };
}

export function createDefaultProviderPresentation(): ProviderPresentation {
  return {
    shouldDeliverAcknowledgement(provider) {
      return shouldDeliverRunStatusPresentation(provider);
    },

    shouldDeliverStatusUpdate(provider) {
      if (provider === "slack" || provider === "lark") return true;
      return shouldDeliverRunStatusPresentation(provider);
    },

    shouldDeliverRunStatusUpdate(input) {
      return this.shouldDeliverStatusUpdate(input.provider);
    },

    shouldDeliverProgress(provider) {
      return shouldDeliverProgressPresentation(provider);
    },

    runStatusPresentation(input) {
      return createRunStatusPresentation({
        runId: input.runId,
        state: input.state,
        ...(input.message ? { message: input.message } : {}),
        ...(input.nextAction ? { nextAction: input.nextAction } : {}),
        ...(input.detailVisibility ? { detailVisibility: input.detailVisibility } : {})
      });
    },

    acknowledgementPresentation(input) {
      return this.runStatusPresentation({
        runId: input.runId,
        state: "received",
        detailVisibility: "source_thread"
      });
    },

    progressPresentation(input) {
      return this.runStatusPresentation({
        runId: input.runId,
        state: "running",
        message: input.message,
        detailVisibility: "audit"
      });
    },

    finalPresentation(input) {
      return createFinalSummaryPresentation({
        result: input.result,
        ...(input.receiptContext ? { receiptContext: input.receiptContext } : {}),
        ...(input.runId ? { auditRunId: input.runId } : {})
      });
    },

    render(input) {
      if (input.presentation.kind === "approval_prompt") {
        return renderApprovalPrompt(input.provider, input.presentation);
      }
      if (input.presentation.kind === "run_status") {
        return renderRunStatus(input.provider, input.presentation, {
          ...(input.larkRenderLocale ? { larkRenderLocale: input.larkRenderLocale } : {})
        });
      }
      if (input.presentation.kind === "final_summary") {
        return renderFinalSummary(input.provider, input.presentation, {
          ...(input.larkRenderLocale ? { larkRenderLocale: input.larkRenderLocale } : {})
        });
      }
      if (input.presentation.kind === "doctor_summary") {
        return renderDoctorSummary(input.provider, input.presentation);
      }
      if (input.presentation.kind === "source_thread_status") {
        return renderSourceThreadStatus(input.provider, input.presentation);
      }
      if (input.presentation.kind === "action_receipt") {
        return renderActionReceipt(input.provider, input.presentation, {
          ...(input.larkRenderLocale ? { larkRenderLocale: input.larkRenderLocale } : {})
        });
      }
      return {
        body: renderOpenTagPresentationPlainText(input.presentation)
      };
    },

    acknowledgement(input) {
      return this.render({ provider: input.provider, presentation: this.acknowledgementPresentation({ runId: input.runId }) }).body;
    },

    runStatus(input) {
      return this.render({
        provider: input.provider,
        ...(input.larkRenderLocale ? { larkRenderLocale: input.larkRenderLocale } : {}),
        presentation: this.runStatusPresentation({
          runId: input.runId,
          state: input.state,
          ...(input.message ? { message: input.message } : {}),
          ...(input.nextAction ? { nextAction: input.nextAction } : {}),
          ...(input.detailVisibility ? { detailVisibility: input.detailVisibility } : {})
        })
      });
    },

    progress(input) {
      return this.runStatus({
        provider: input.provider,
        runId: input.runId,
        state: "running",
        message: input.message,
        detailVisibility: "audit"
      }).body;
    },

    final(input) {
      return this.render({
        provider: input.provider,
        ...(input.larkRenderLocale ? { larkRenderLocale: input.larkRenderLocale } : {}),
        presentation: this.finalPresentation({
          result: input.result,
          ...(input.runId ? { runId: input.runId } : {}),
          ...(input.receiptContext ? { receiptContext: input.receiptContext } : {})
        })
      });
    }
  };
}

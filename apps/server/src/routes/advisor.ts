import { Hono } from "hono";
import { streamText } from "hono/streaming";
import type { AdvisorChatRequest, Scenario, ProjectionRunResponse } from "../../../../packages/shared/types";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const MODEL = process.env.ADVISOR_MODEL ?? "hermes3:latest";

const SYSTEM_PROMPT = `You are a financial advisor helping the user reason about whether to borrow against home equity (HELOC) to invest in a diversified portfolio.

You will be given a structured JSON snapshot of the user's current scenario, projection results, and tax profile. Quote numbers directly from this snapshot — never invent figures. If the user asks about something not in the snapshot, say so plainly.

Style:
- Conversational but precise. No jargon without explaining it.
- Short paragraphs. Lead with the answer, then the reasoning.
- When citing a dollar figure, round sensibly ($1.2M, $45k) unless the user asks for exact.
- Flag meaningful risks (underwater scenarios, forced liquidation, break-even sensitivity) when relevant.
- You are not a fiduciary and cannot give legal or tax advice. If asked for a recommendation, frame tradeoffs rather than issuing a directive.`;

function buildContext(scenario: Scenario, runResult: ProjectionRunResponse): string {
  const takeLoan = scenario.events.find((e) => e.kind === "take_loan");
  const loanPayload = takeLoan?.payload as { principal: number; apr: number; term_months: number } | undefined;

  const months = runResult.timeline.months;
  const lastRow = months[months.length - 1];
  const cmpMonths = runResult.comparison?.months;
  const cmpLast = cmpMonths && cmpMonths.length > 0 ? cmpMonths[cmpMonths.length - 1] : undefined;
  const mc = runResult.timeline.mc;

  const ctx = {
    scenario: {
      startDate: scenario.startDate,
      horizonMonths: scenario.horizonMonths,
      homeValue: scenario.initialHomeValue,
      existingMortgage: scenario.existingMortgage ?? null,
      portfolioValue: scenario.initialPortfolioValue,
      monthlyIncome: scenario.monthlyIncome,
      monthlyExpense: scenario.monthlyExpense,
      assumedMarketReturnPct: scenario.baselineReturnPct,
      assumedMarketVolPct: scenario.baselineVolPct,
      assumedHomeAppreciationPct: scenario.homeAppreciationPct,
      heloc: loanPayload
        ? {
            principal: loanPayload.principal,
            aprPct: loanPayload.apr,
            termMonths: loanPayload.term_months,
          }
        : null,
      monteCarloEnabled: scenario.mc.enabled,
      monteCarloPaths: scenario.mc.paths,
    },
    taxProfile: scenario.tax,
    projection: {
      finalNetWorth: runResult.summary.finalNetWorth,
      finalNetWorthAfterTaxIfLiquidated: runResult.summary.finalNetWorthAfterTaxIfLiquidated,
      deltaVsBaseline: runResult.summary.deltaVsBaseline,
      breakEvenReturnPct: runResult.summary.breakEvenReturnPct,
      totalInterestPaid: lastRow?.cumulativeInterestPaid ?? 0,
      totalTaxSaved: lastRow?.cumulativeTaxSaved ?? 0,
      finalMonthUnderwater: lastRow?.underwaterOnHome ?? false,
      firstMonthUnderwaterOnHome: runResult.summary.firstMonthUnderwaterOnHome ?? null,
      anyForcedLiquidation: months.some((m) => m.forcedLiquidation),
      baselineFinalNetWorth: cmpLast?.netWorth ?? null,
      monteCarlo: mc
        ? {
            p10FinalNetWorth: mc.p10[mc.p10.length - 1] ?? null,
            p50FinalNetWorth: mc.p50[mc.p50.length - 1] ?? null,
            p90FinalNetWorth: mc.p90[mc.p90.length - 1] ?? null,
            successProbability: runResult.summary.mcSuccessProbability ?? null,
          }
        : null,
      warnings: runResult.timeline.warnings,
    },
  };
  return JSON.stringify(ctx, null, 2);
}

const route = new Hono();

route.post("/chat", async (c) => {
  const body = (await c.req.json()) as AdvisorChatRequest;
  if (!body.messages || !body.scenario || !body.runResult) {
    return c.json({ error: "missing messages, scenario, or runResult" }, 400);
  }
  const context = buildContext(body.scenario, body.runResult);
  const systemWithContext = `${SYSTEM_PROMPT}\n\nCurrent snapshot (JSON):\n${context}`;
  const ollamaBody = {
    model: MODEL,
    stream: true,
    messages: [
      { role: "system", content: systemWithContext },
      ...body.messages,
    ],
  };

  const upstream = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(ollamaBody),
  });
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return c.json({ error: `ollama error ${upstream.status}`, detail: text }, 502);
  }

  return streamText(c, async (stream) => {
    const reader = upstream.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const obj = JSON.parse(line) as { message?: { content?: string }; done?: boolean };
          const token = obj.message?.content ?? "";
          if (token) await stream.write(token);
        } catch {
          // Ignore malformed lines (shouldn't happen with ollama NDJSON).
        }
      }
    }
  });
});

route.get("/model", (c) => c.json({ model: MODEL, ollamaUrl: OLLAMA_URL }));

export default route;

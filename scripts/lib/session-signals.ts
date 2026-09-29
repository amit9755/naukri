// Serialized into the browser by page.evaluate. Return booleans only; never values,
// page text, attributes, credentials, or authentication material.
export function readSessionSignals() {
  const visible = (element: Element) => {
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
  };
  const inputs = Array.from(document.querySelectorAll<HTMLInputElement>("input")).filter(visible);
  const description = (input: HTMLInputElement) => [
    input.id, input.name, input.placeholder, input.getAttribute("aria-label") ?? "",
    ...Array.from(input.labels ?? []).map((label) => label.textContent ?? ""),
  ].join(" ");
  const otpInput = inputs.some((input) => input.autocomplete === "one-time-code" ||
    /\botp\b|one[-\s]?time (?:password|passcode|code)|verification code|security code|(?:^|[\s_-])otp(?:code|input|digit|field)?\d*(?=$|[\s_-])/i.test(description(input)));
  const captchaDetected = Array.from(document.querySelectorAll<HTMLIFrameElement>("iframe")).some((frame) =>
    visible(frame) && !/[?&]size=invisible(?:&|$)/i.test(frame.src) && /captcha|challenges\.cloudflare\.com/i.test(`${frame.src} ${frame.title}`)) ||
    Array.from(document.querySelectorAll('[data-sitekey], [role="checkbox"]')).some((element) =>
      visible(element) && ((element.hasAttribute("data-sitekey") && element.getAttribute("data-size") !== "invisible") || /not a robot/i.test(element.getAttribute("aria-label") ?? element.textContent ?? ""))) ||
    inputs.some((input) => /captcha/i.test(description(input)));
  // Only prominent visible prompts, not alternative-login links or generic body
  // mentions of OTP/MFA/verification. No form interaction is performed here.
  const prompts = Array.from(document.querySelectorAll('h1, h2, h3, [role="heading"], [role="alert"], [role="dialog"]'))
    .filter(visible).map((element) => element.textContent?.trim() ?? "");
  const mfaDetected = inputs.some((input) => /authenticator|\bmfa\b|\b2fa\b|recovery code|backup code/i.test(description(input))) ||
    prompts.some((text) => /^(?:two[- ]factor authentication|two[- ]step verification|multi[- ]factor authentication|enter (?:the |your )?(?:authenticator|backup|recovery) code|approve (?:this |the )?(?:sign[- ]?in|login))/i.test(text));
  const verificationPrompt = prompts.some((text) => /^(?:checking your browser|just a moment|verify (?:that )?you(?:'re| are) (?:a )?human|security verification|verify your (?:identity|email|mobile|phone)|enter (?:the |your )?(?:otp|one[- ]time (?:password|passcode|code)|verification code)|enable javascript and cookies to continue)/i.test(text));
  const text = `${document.title}\n${document.body?.innerText ?? ""}`;
  const accessDenied = /access denied|access forbidden|request (?:was )?(?:blocked|rejected)|you (?:have been|are) blocked|unusual traffic|pardon our interruption/i.test(text);
  const passwordForm = inputs.some((input) => input.type === "password");
  const signOutVisible = Array.from(document.querySelectorAll('a, button, [role="button"], [role="menuitem"]'))
    .some((element) => visible(element) && /^(?:log\s*out|sign\s*out)$/i.test(element.textContent?.trim() ?? ""));
  return { captchaDetected, accessDenied, otpInput, mfaDetected, verificationPrompt,
    verificationDetected: captchaDetected || otpInput || mfaDetected || verificationPrompt,
    passwordForm, signOutVisible };
}

export type ChallengeDetected = "none" | "otp" | "captcha" | "mfa" | "access-restriction" | "unknown";

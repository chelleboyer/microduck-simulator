// Jump Forward button: the one-press entry to the community hop policy
// (game/jump.js). Shown in BOTH layouts - desktop centres it along the
// bottom edge, touch mode parks it above the A/B caps so a thumb reaches
// it - because the rest of the HUD chrome is stripped on touch.
//
// The label follows the jump state machine (loading -> getting ready ->
// jumping -> landing) and the button stays disabled until the duck is
// back on its feet, so presses can't stack. Failures (Hub unreachable,
// incompatible policy, an aborted hop) print right under it, in both
// layouts, instead of falling back to a stock behavior.
//
// Mobile Safari: a plain <button> with onClick (fires on tap), touch-action
// manipulation (no double-tap zoom delay) and no hover-only affordances.
import Box from "@mui/material/Box";
import { useGame, gameApi } from "../store.js";
import { uiClick } from "../game/audio.js";
import { ORANGE, MONO } from "../theme.js";
import { ANTON, COMIC_INK, CREAM } from "./comic.jsx";

const LABELS = {
  idle: "Jump Forward",
  ready: "Jump Forward",
  error: "Retry Jump",
  loading: "Loading jump…",
  preparing: "Getting ready…",
  jumping: "Jumping!",
  landing: "Landing…",
};

const PRESSABLE = new Set(["idle", "ready", "error"]);

export default function JumpButton() {
  const entered = useGame((s) => s.entered);
  const menuOpen = useGame((s) => s.menuOpen);
  const bootDone = useGame((s) => s.bootDone);
  const touchMode = useGame((s) => s.touchMode);
  const loco = useGame((s) => s.loco);
  const jump = useGame((s) => s.jump);
  if (!entered || menuOpen || !bootDone) return null;

  const legs = loco === "legs";
  const enabled = legs && PRESSABLE.has(jump.status);
  const label = legs ? LABELS[jump.status] ?? "Jump Forward" : "Jump (legs only)";
  const message = jump.error
    ? `${jump.status === "error" ? "Jump unavailable" : "Jump stopped"} · ${jump.error}`
    : null;

  const onClick = (e) => {
    // Drop focus so a later Space (sim reset) doesn't re-press the button.
    e.currentTarget.blur();
    if (!enabled) return;
    uiClick();
    gameApi.jumpForward?.();
  };

  return (
    <Box
      sx={{
        position: "fixed",
        zIndex: 12,
        display: "flex",
        flexDirection: "column",
        alignItems: touchMode ? "flex-end" : "center",
        gap: "0.45rem",
        maxWidth: "min(22rem, calc(100vw - 2.6rem))",
        ...(touchMode
          ? {
            right: "calc(1.3rem + env(safe-area-inset-right, 0px))",
            bottom: "calc(11.6rem + env(safe-area-inset-bottom, 0px))",
          }
          : {
            left: "50%",
            transform: "translateX(-50%)",
            bottom: "calc(1.25rem + env(safe-area-inset-bottom, 0px))",
            // Narrow windows: lift it over the bottom-left quickbar.
            "@media (max-width: 899px)": { bottom: "calc(5rem + env(safe-area-inset-bottom, 0px))" },
          }),
      }}
    >
      {message ? (
        <Box
          role="alert"
          data-testid="jump-error"
          sx={{
            fontFamily: MONO,
            fontSize: "0.64rem",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            lineHeight: 1.6,
            textAlign: touchMode ? "right" : "center",
            color: "#ff4b3a",
            textShadow: "0 0 8px rgba(255, 75, 58, 0.45), 0 1px 2px rgba(0, 0, 0, 0.8)",
          }}
        >
          {message}
        </Box>
      ) : null}
      <Box
        component="button"
        type="button"
        id="jump-forward"
        data-testid="jump-forward"
        aria-label="Jump Forward"
        aria-disabled={!enabled}
        aria-live="polite"
        data-status={jump.status}
        onClick={onClick}
        sx={{
          appearance: "none",
          minHeight: 48,
          px: "1.3rem",
          border: `2px solid ${COMIC_INK}`,
          borderRadius: 0,
          boxShadow: `3px 3px 0 ${COMIC_INK}`,
          background: enabled ? ORANGE : "rgba(250, 248, 242, 0.82)",
          color: COMIC_INK,
          fontFamily: ANTON,
          fontSize: "1.05rem",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          lineHeight: 1,
          whiteSpace: "nowrap",
          cursor: enabled ? "pointer" : "default",
          opacity: legs ? 1 : 0.6,
          touchAction: "manipulation",
          userSelect: "none",
          WebkitUserSelect: "none",
          WebkitTapHighlightColor: "transparent",
          transition: "background 0.15s ease, transform 0.08s ease",
          "&:active": enabled ? { transform: "translate(2px, 2px)", boxShadow: `1px 1px 0 ${COMIC_INK}` } : {},
          "&:focus-visible": { outline: `2px dashed ${CREAM}`, outlineOffset: 3 },
        }}
      >
        {label}
      </Box>
    </Box>
  );
}

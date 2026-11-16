import { FocusContext, useFocusable, type FocusableComponentLayout } from "@noriginmedia/norigin-spatial-navigation";
import { type CSSProperties, type ReactNode, useCallback } from "react";

/** Keep the focused element on screen: rows scroll sideways, the page scrolls to the row. */
export function scrollIntoViewSoft(node: HTMLElement | null | undefined) {
  if (!node) return;
  node.scrollIntoView({ block: "nearest", inline: "nearest" });
  const row = node.closest("[data-row]") as HTMLElement | null;
  if (row) row.scrollIntoView({ block: "center" });
}

interface Props {
  children: ReactNode | ((focused: boolean) => ReactNode);
  onEnter?: () => void;
  onFocus?: () => void;
  className?: string;
  focusedClassName?: string;
  style?: CSSProperties;
  focusKey?: string;
  as?: "div" | "button";
  testId?: string;
  label?: string;
}

/**
 * One focusable thing: D-pad focus via norigin, Magic Remote pointer via mouse
 * events (hover focuses, click activates), touch/click on phones.
 */
export function Focusable({ children, onEnter, onFocus, className = "", focusedClassName = "is-focused", style, focusKey, testId, label }: Props) {
  const { ref, focused, focusSelf } = useFocusable({
    focusKey,
    onEnterPress: () => onEnter?.(),
    onFocus: (layout: FocusableComponentLayout) => {
      scrollIntoViewSoft(layout.node as HTMLElement);
      onFocus?.();
    },
  });
  const click = useCallback(() => {
    focusSelf();
    onEnter?.();
  }, [focusSelf, onEnter]);
  return (
    <div
      ref={ref}
      role="button"
      tabIndex={-1}
      aria-label={label}
      data-testid={testId}
      data-focused={focused ? "true" : undefined}
      className={`${className} ${focused ? focusedClassName : ""}`}
      style={style}
      onMouseEnter={() => focusSelf()}
      onClick={click}
    >
      {typeof children === "function" ? children(focused) : children}
    </div>
  );
}

/** A focus container that remembers its last focused child (rows, menus). */
export function FocusGroup({ children, focusKey, className, testId, boundary }: { children: ReactNode; focusKey?: string; className?: string; testId?: string; boundary?: boolean }) {
  const { ref, focusKey: key } = useFocusable({ focusKey, saveLastFocusedChild: true, trackChildren: true, isFocusBoundary: boundary });
  return (
    <FocusContext.Provider value={key}>
      <div ref={ref} className={className} data-testid={testId}>
        {children}
      </div>
    </FocusContext.Provider>
  );
}

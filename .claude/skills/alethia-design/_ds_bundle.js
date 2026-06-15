/* @ds-bundle: {"format":3,"namespace":"VertexDesignSystem_8c015f","components":[{"name":"Badge","sourcePath":"components/buttons/Badge.jsx"},{"name":"Button","sourcePath":"components/buttons/Button.jsx"},{"name":"Kbd","sourcePath":"components/buttons/Kbd.jsx"},{"name":"Alert","sourcePath":"components/feedback/Alert.jsx"},{"name":"Spinner","sourcePath":"components/feedback/Alert.jsx"},{"name":"StatusBadge","sourcePath":"components/feedback/StatusBadge.jsx"},{"name":"Checkbox","sourcePath":"components/forms/Checkbox.jsx"},{"name":"Radio","sourcePath":"components/forms/Checkbox.jsx"},{"name":"Field","sourcePath":"components/forms/Field.jsx"},{"name":"Label","sourcePath":"components/forms/Field.jsx"},{"name":"Hint","sourcePath":"components/forms/Field.jsx"},{"name":"Input","sourcePath":"components/forms/Input.jsx"},{"name":"Textarea","sourcePath":"components/forms/Input.jsx"},{"name":"Select","sourcePath":"components/forms/Select.jsx"},{"name":"Switch","sourcePath":"components/forms/Switch.jsx"},{"name":"Tabs","sourcePath":"components/navigation/Tabs.jsx"},{"name":"Avatar","sourcePath":"components/surfaces/Avatar.jsx"},{"name":"Card","sourcePath":"components/surfaces/Card.jsx"},{"name":"CardHeader","sourcePath":"components/surfaces/Card.jsx"},{"name":"CardTitle","sourcePath":"components/surfaces/Card.jsx"},{"name":"CardDescription","sourcePath":"components/surfaces/Card.jsx"},{"name":"CardBody","sourcePath":"components/surfaces/Card.jsx"},{"name":"CardFooter","sourcePath":"components/surfaces/Card.jsx"},{"name":"Separator","sourcePath":"components/surfaces/Separator.jsx"}],"sourceHashes":{"components/buttons/Badge.jsx":"047fa17b0ff4","components/buttons/Button.jsx":"f3b5ba412bbb","components/buttons/Kbd.jsx":"ad807993a0fd","components/feedback/Alert.jsx":"3845f66729ad","components/feedback/StatusBadge.jsx":"4730e4d183b7","components/forms/Checkbox.jsx":"947a55761fa6","components/forms/Field.jsx":"3cc9dcf9e0ae","components/forms/Input.jsx":"b9a3c7c65aa8","components/forms/Select.jsx":"8594e8bae0df","components/forms/Switch.jsx":"716cd8a0ef91","components/navigation/Tabs.jsx":"a10f819dfd81","components/surfaces/Avatar.jsx":"ed3235970c09","components/surfaces/Card.jsx":"acc5d2e0d16a","components/surfaces/Separator.jsx":"471014007d62","ui_kits/vertex-app/icons.jsx":"ed61f3f084bb","ui_kits/vertex-app/screens.jsx":"33ee0891b6eb","ui_kits/vertex-app/shell.jsx":"80aee4917e05","ui_kits/vertex-web/sections.jsx":"2c9a35c01254"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.VertexDesignSystem_8c015f = window.VertexDesignSystem_8c015f || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/buttons/Badge.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Alethia Badge — compact metadata label.
 * `mono` renders an uppercase Geist Mono micro-label, the system's
 * signature device for tags like region codes and versions.
 */
function Badge({
  variant = "muted",
  mono = false,
  className = "",
  children,
  ...props
}) {
  const cls = ["vx-badge", `vx-badge--${variant}`, mono ? "vx-badge--mono" : "", className].filter(Boolean).join(" ");
  return /*#__PURE__*/React.createElement("span", _extends({
    className: cls
  }, props), children);
}
Object.assign(__ds_scope, { Badge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/buttons/Badge.jsx", error: String((e && e.message) || e) }); }

// components/buttons/Button.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Alethia Button — the primary action primitive.
 * Monochrome by design: `primary` is solid ink, everything else
 * is border/fill/ghost. `destructive` stays grayscale (outline that
 * fills on hover) and relies on copy + an icon to signal danger.
 */
function Button({
  variant = "primary",
  size = "md",
  icon = false,
  className = "",
  as,
  children,
  ...props
}) {
  const Comp = as || "button";
  const cls = ["vx-btn", `vx-btn--${variant}`, `vx-btn--${size}`, icon ? "vx-btn--icon" : "", className].filter(Boolean).join(" ");
  return /*#__PURE__*/React.createElement(Comp, _extends({
    className: cls
  }, props), children);
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/buttons/Button.jsx", error: String((e && e.message) || e) }); }

// components/buttons/Kbd.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Keyboard key cap — for shortcut hints (⌘K, ↑↓, q). */
function Kbd({
  className = "",
  children,
  ...props
}) {
  return /*#__PURE__*/React.createElement("kbd", _extends({
    className: ["vx-kbd", className].filter(Boolean).join(" ")
  }, props), children);
}
Object.assign(__ds_scope, { Kbd });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/buttons/Kbd.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Alert.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Inline alert / callout. `variant="critical"` for destructive context. */
function Alert({
  variant = "default",
  title,
  icon,
  className = "",
  children,
  ...props
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    className: ["vx-alert", variant === "critical" ? "vx-alert--critical" : "", className].filter(Boolean).join(" "),
    role: "note"
  }, props), icon && /*#__PURE__*/React.createElement("span", {
    className: "vx-alert__icon"
  }, icon), /*#__PURE__*/React.createElement("div", null, title && /*#__PURE__*/React.createElement("div", {
    className: "vx-alert__title"
  }, title), children && /*#__PURE__*/React.createElement("div", {
    className: "vx-alert__body"
  }, children)));
}

/** Indeterminate loading spinner. */
function Spinner({
  size = 16,
  className = "",
  style,
  ...props
}) {
  return /*#__PURE__*/React.createElement("span", _extends({
    className: ["vx-spinner", className].filter(Boolean).join(" "),
    style: {
      width: size,
      height: size,
      ...style
    },
    role: "status",
    "aria-label": "Loading"
  }, props));
}
Object.assign(__ds_scope, { Alert, Spinner });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Alert.jsx", error: String((e && e.message) || e) }); }

// components/feedback/StatusBadge.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const LABELS = {
  active: "Active",
  online: "Online",
  success: "Success",
  pending: "Pending",
  processing: "Processing",
  queued: "Queued",
  idle: "Idle",
  failed: "Failed",
  destroyed: "Destroyed",
  disabled: "Disabled",
  live: "Live"
};
// Map many product statuses onto five grayscale visual tiers.
const TIER = {
  active: "active",
  online: "active",
  success: "active",
  pending: "pending",
  processing: "pending",
  queued: "pending",
  idle: "idle",
  failed: "failed",
  destroyed: "failed",
  disabled: "disabled",
  live: "live"
};

/**
 * StatusBadge — grayscale state indicator. State is read through dot
 * fill/shape + label, never color. Pass a known `status` or a custom label.
 */
function StatusBadge({
  status = "idle",
  children,
  showLabel = true,
  className = "",
  ...props
}) {
  const tier = TIER[status] || "idle";
  const label = children != null ? children : LABELS[status] || status;
  return /*#__PURE__*/React.createElement("span", _extends({
    className: ["vx-status", `vx-status--${tier}`, className].filter(Boolean).join(" ")
  }, props), /*#__PURE__*/React.createElement("span", {
    className: "vx-status__dot"
  }), showLabel && /*#__PURE__*/React.createElement("span", null, label));
}
Object.assign(__ds_scope, { StatusBadge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/StatusBadge.jsx", error: String((e && e.message) || e) }); }

// components/forms/Checkbox.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const Check = () => /*#__PURE__*/React.createElement("svg", {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "3",
  "aria-hidden": "true"
}, /*#__PURE__*/React.createElement("path", {
  d: "M20 6 9 17l-5-5",
  strokeLinecap: "round",
  strokeLinejoin: "round"
}));

/** Checkbox with label. Pass `children` as the label text. */
function Checkbox({
  className = "",
  children,
  ...props
}) {
  return /*#__PURE__*/React.createElement("label", {
    className: ["vx-check", className].filter(Boolean).join(" ")
  }, /*#__PURE__*/React.createElement("input", _extends({
    type: "checkbox"
  }, props)), /*#__PURE__*/React.createElement("span", {
    className: "vx-check__box"
  }, /*#__PURE__*/React.createElement(Check, null)), children != null && /*#__PURE__*/React.createElement("span", null, children));
}

/** Radio with label. Group by shared `name`. */
function Radio({
  className = "",
  children,
  ...props
}) {
  return /*#__PURE__*/React.createElement("label", {
    className: ["vx-check", className].filter(Boolean).join(" ")
  }, /*#__PURE__*/React.createElement("input", _extends({
    type: "radio"
  }, props)), /*#__PURE__*/React.createElement("span", {
    className: "vx-check__box vx-check__box--radio"
  }), children != null && /*#__PURE__*/React.createElement("span", null, children));
}
Object.assign(__ds_scope, { Checkbox, Radio });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Checkbox.jsx", error: String((e && e.message) || e) }); }

// components/forms/Field.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Vertical field wrapper: label + control + hint, gap-spaced. */
function Field({
  className = "",
  children,
  ...props
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    className: ["vx-field", className].filter(Boolean).join(" ")
  }, props), children);
}

/** Form label. */
function Label({
  className = "",
  children,
  ...props
}) {
  return /*#__PURE__*/React.createElement("label", _extends({
    className: ["vx-label", className].filter(Boolean).join(" ")
  }, props), children);
}

/** Secondary helper text under a control. */
function Hint({
  className = "",
  children,
  ...props
}) {
  return /*#__PURE__*/React.createElement("p", _extends({
    className: ["vx-hint", className].filter(Boolean).join(" ")
  }, props), children);
}
Object.assign(__ds_scope, { Field, Label, Hint });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Field.jsx", error: String((e && e.message) || e) }); }

// components/forms/Input.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Single-line text input. Add `mono` for code / token / ID entry. */
function Input({
  mono = false,
  className = "",
  ...props
}) {
  const cls = ["vx-input", mono ? "vx-input--mono" : "", className].filter(Boolean).join(" ");
  return /*#__PURE__*/React.createElement("input", _extends({
    className: cls
  }, props));
}

/** Multi-line text input. */
function Textarea({
  className = "",
  ...props
}) {
  return /*#__PURE__*/React.createElement("textarea", _extends({
    className: ["vx-textarea", className].filter(Boolean).join(" ")
  }, props));
}
Object.assign(__ds_scope, { Input, Textarea });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Input.jsx", error: String((e && e.message) || e) }); }

// components/forms/Select.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Styled native select with a chevron affordance. */
function Select({
  options,
  className = "",
  children,
  ...props
}) {
  return /*#__PURE__*/React.createElement("span", {
    className: "vx-select-wrap"
  }, /*#__PURE__*/React.createElement("select", _extends({
    className: ["vx-select", className].filter(Boolean).join(" ")
  }, props), options ? options.map(o => {
    const opt = typeof o === "string" ? {
      value: o,
      label: o
    } : o;
    return /*#__PURE__*/React.createElement("option", {
      key: opt.value,
      value: opt.value
    }, opt.label);
  }) : children), /*#__PURE__*/React.createElement("svg", {
    className: "vx-select-wrap__chevron",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    "aria-hidden": "true"
  }, /*#__PURE__*/React.createElement("path", {
    d: "m6 9 6 6 6-6",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  })));
}
Object.assign(__ds_scope, { Select });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Select.jsx", error: String((e && e.message) || e) }); }

// components/forms/Switch.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** On/off toggle. Controlled via `checked` + `onChange`, like an input. */
function Switch({
  className = "",
  ...props
}) {
  return /*#__PURE__*/React.createElement("label", {
    className: ["vx-switch", className].filter(Boolean).join(" ")
  }, /*#__PURE__*/React.createElement("input", _extends({
    type: "checkbox",
    role: "switch"
  }, props)), /*#__PURE__*/React.createElement("span", {
    className: "vx-switch__track"
  }), /*#__PURE__*/React.createElement("span", {
    className: "vx-switch__thumb"
  }));
}
Object.assign(__ds_scope, { Switch });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Switch.jsx", error: String((e && e.message) || e) }); }

// components/navigation/Tabs.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Tabs — controlled segmented navigation.
 * `variant="pill"` renders the inset pill group; default is the
 * underline rail. Pass `tabs` + `value` + `onValueChange`.
 */
function Tabs({
  tabs = [],
  value,
  onValueChange,
  variant = "underline",
  className = "",
  ...props
}) {
  const cls = ["vx-tabs", variant === "pill" ? "vx-tabs--pill" : "", className].filter(Boolean).join(" ");
  return /*#__PURE__*/React.createElement("div", _extends({
    className: cls,
    role: "tablist"
  }, props), tabs.map(t => {
    const tab = typeof t === "string" ? {
      id: t,
      label: t
    } : t;
    const active = tab.id === value;
    return /*#__PURE__*/React.createElement("button", {
      key: tab.id,
      role: "tab",
      "aria-selected": active,
      className: ["vx-tab", active ? "vx-tab--active" : ""].filter(Boolean).join(" "),
      onClick: () => onValueChange && onValueChange(tab.id)
    }, tab.label);
  }));
}
Object.assign(__ds_scope, { Tabs });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/navigation/Tabs.jsx", error: String((e && e.message) || e) }); }

// components/surfaces/Avatar.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const SIZES = {
  xs: 22,
  sm: 28,
  md: 36,
  lg: 44
};

/** Avatar — image with initials fallback. Square-ish radius or full circle. */
function Avatar({
  src,
  alt = "",
  initials,
  size = "md",
  square = false,
  className = "",
  style,
  ...props
}) {
  const px = typeof size === "number" ? size : SIZES[size] || 36;
  return /*#__PURE__*/React.createElement("span", _extends({
    className: ["vx-avatar", className].filter(Boolean).join(" "),
    style: {
      width: px,
      height: px,
      borderRadius: square ? "var(--radius-md)" : "var(--radius-full)",
      fontSize: px * 0.36,
      ...style
    }
  }, props), src ? /*#__PURE__*/React.createElement("img", {
    src: src,
    alt: alt
  }) : (initials || "").slice(0, 2).toUpperCase());
}
Object.assign(__ds_scope, { Avatar });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/surfaces/Avatar.jsx", error: String((e && e.message) || e) }); }

// components/surfaces/Card.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Surface container. `interactive` adds hover affordance; `flat` drops the shadow. */
function Card({
  interactive = false,
  flat = false,
  className = "",
  children,
  ...props
}) {
  const cls = ["vx-card", interactive ? "vx-card--interactive" : "", flat ? "vx-card--flat" : "", className].filter(Boolean).join(" ");
  return /*#__PURE__*/React.createElement("div", _extends({
    className: cls
  }, props), children);
}
function CardHeader({
  className = "",
  children,
  ...props
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    className: ["vx-card__header", className].filter(Boolean).join(" ")
  }, props), children);
}
function CardTitle({
  className = "",
  children,
  ...props
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    className: ["vx-card__title", className].filter(Boolean).join(" ")
  }, props), children);
}
function CardDescription({
  className = "",
  children,
  ...props
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    className: ["vx-card__desc", className].filter(Boolean).join(" ")
  }, props), children);
}
function CardBody({
  className = "",
  children,
  ...props
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    className: ["vx-card__body", className].filter(Boolean).join(" ")
  }, props), children);
}
function CardFooter({
  className = "",
  children,
  ...props
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    className: ["vx-card__footer", className].filter(Boolean).join(" ")
  }, props), children);
}
Object.assign(__ds_scope, { Card, CardHeader, CardTitle, CardDescription, CardBody, CardFooter });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/surfaces/Card.jsx", error: String((e && e.message) || e) }); }

// components/surfaces/Separator.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Hairline divider. `orientation="vertical"` for inline separators. */
function Separator({
  orientation = "horizontal",
  className = "",
  ...props
}) {
  const cls = ["vx-sep", orientation === "vertical" ? "vx-sep--v" : "vx-sep--h", className].filter(Boolean).join(" ");
  return /*#__PURE__*/React.createElement("div", _extends({
    role: "separator",
    "aria-orientation": orientation,
    className: cls
  }, props));
}
Object.assign(__ds_scope, { Separator });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/surfaces/Separator.jsx", error: String((e && e.message) || e) }); }

// ui_kits/vertex-app/icons.jsx
try { (() => {
/* Alethia UI kit — compact Lucide-style icon set (1.75px stroke, round caps). */
const I = (paths, props = {}) => ({
  size = 18,
  ...rest
}) => React.createElement("svg", {
  viewBox: "0 0 24 24",
  width: size,
  height: size,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  ...props,
  ...rest
}, paths.map((d, i) => React.createElement("path", {
  key: i,
  d
})));
const Circle = (cx, cy, r) => React.createElement("circle", {
  key: "c" + cx + cy,
  cx,
  cy,
  r
});
const Icons = {
  Dashboard: ({
    size = 18,
    ...r
  }) => React.createElement("svg", {
    viewBox: "0 0 24 24",
    width: size,
    height: size,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    ...r
  }, React.createElement("rect", {
    x: 3,
    y: 3,
    width: 7,
    height: 9,
    rx: 1
  }), React.createElement("rect", {
    x: 14,
    y: 3,
    width: 7,
    height: 5,
    rx: 1
  }), React.createElement("rect", {
    x: 14,
    y: 12,
    width: 7,
    height: 9,
    rx: 1
  }), React.createElement("rect", {
    x: 3,
    y: 16,
    width: 7,
    height: 5,
    rx: 1
  })),
  Plus: I(["M12 5v14", "M5 12h14"]),
  Server: ({
    size = 18,
    ...r
  }) => React.createElement("svg", {
    viewBox: "0 0 24 24",
    width: size,
    height: size,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    ...r
  }, React.createElement("rect", {
    x: 3,
    y: 4,
    width: 18,
    height: 7,
    rx: 1.5
  }), React.createElement("rect", {
    x: 3,
    y: 13,
    width: 18,
    height: 7,
    rx: 1.5
  }), React.createElement("path", {
    d: "M7 7.5h.01M7 16.5h.01"
  })),
  Jobs: ({
    size = 18,
    ...r
  }) => React.createElement("svg", {
    viewBox: "0 0 24 24",
    width: size,
    height: size,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    ...r
  }, React.createElement("rect", {
    x: 8,
    y: 2,
    width: 8,
    height: 4,
    rx: 1
  }), React.createElement("path", {
    d: "M9 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-3M9 12l2 2 4-4"
  })),
  Blocks: ({
    size = 18,
    ...r
  }) => React.createElement("svg", {
    viewBox: "0 0 24 24",
    width: size,
    height: size,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    ...r
  }, React.createElement("rect", {
    x: 3,
    y: 3,
    width: 8,
    height: 8,
    rx: 1
  }), React.createElement("rect", {
    x: 13,
    y: 3,
    width: 8,
    height: 8,
    rx: 1
  }), React.createElement("rect", {
    x: 3,
    y: 13,
    width: 8,
    height: 8,
    rx: 1
  }), React.createElement("rect", {
    x: 13,
    y: 13,
    width: 8,
    height: 8,
    rx: 1
  })),
  Workflow: ({
    size = 18,
    ...r
  }) => React.createElement("svg", {
    viewBox: "0 0 24 24",
    width: size,
    height: size,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    ...r
  }, React.createElement("rect", {
    x: 3,
    y: 3,
    width: 7,
    height: 7,
    rx: 1
  }), React.createElement("rect", {
    x: 14,
    y: 14,
    width: 7,
    height: 7,
    rx: 1
  }), React.createElement("path", {
    d: "M6.5 10v4a2 2 0 0 0 2 2H14"
  })),
  Bell: I(["M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9", "M10.3 21a1.94 1.94 0 0 0 3.4 0"]),
  Search: ({
    size = 18,
    ...r
  }) => React.createElement("svg", {
    viewBox: "0 0 24 24",
    width: size,
    height: size,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    ...r
  }, Circle(11, 11, 7), React.createElement("path", {
    d: "m21 21-4.3-4.3"
  })),
  ChevronDown: I(["m6 9 6 6 6-6"]),
  ChevronRight: I(["m9 6 6 6-6 6"]),
  ArrowRight: I(["M5 12h14", "m13 6 6 6-6 6"]),
  Terminal: I(["m4 17 6-6-6-6", "M12 19h8"]),
  Shield: I(["M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"]),
  GitBranch: ({
    size = 18,
    ...r
  }) => React.createElement("svg", {
    viewBox: "0 0 24 24",
    width: size,
    height: size,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    ...r
  }, React.createElement("line", {
    x1: 6,
    y1: 3,
    x2: 6,
    y2: 15
  }), Circle(18, 6, 3), Circle(6, 18, 3), React.createElement("path", {
    d: "M18 9a9 9 0 0 1-9 9"
  })),
  Cpu: ({
    size = 18,
    ...r
  }) => React.createElement("svg", {
    viewBox: "0 0 24 24",
    width: size,
    height: size,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    ...r
  }, React.createElement("rect", {
    x: 6,
    y: 6,
    width: 12,
    height: 12,
    rx: 2
  }), React.createElement("path", {
    d: "M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"
  })),
  Database: ({
    size = 18,
    ...r
  }) => React.createElement("svg", {
    viewBox: "0 0 24 24",
    width: size,
    height: size,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    ...r
  }, React.createElement("ellipse", {
    cx: 12,
    cy: 5,
    rx: 8,
    ry: 3
  }), React.createElement("path", {
    d: "M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"
  })),
  Network: ({
    size = 18,
    ...r
  }) => React.createElement("svg", {
    viewBox: "0 0 24 24",
    width: size,
    height: size,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    ...r
  }, React.createElement("rect", {
    x: 9,
    y: 2,
    width: 6,
    height: 6,
    rx: 1
  }), React.createElement("rect", {
    x: 3,
    y: 16,
    width: 6,
    height: 6,
    rx: 1
  }), React.createElement("rect", {
    x: 15,
    y: 16,
    width: 6,
    height: 6,
    rx: 1
  }), React.createElement("path", {
    d: "M12 8v4M12 12H6v4M12 12h6v4"
  })),
  Lock: ({
    size = 18,
    ...r
  }) => React.createElement("svg", {
    viewBox: "0 0 24 24",
    width: size,
    height: size,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    ...r
  }, React.createElement("rect", {
    x: 4,
    y: 11,
    width: 16,
    height: 10,
    rx: 2
  }), React.createElement("path", {
    d: "M8 11V7a4 4 0 0 1 8 0v4"
  })),
  Key: ({
    size = 18,
    ...r
  }) => React.createElement("svg", {
    viewBox: "0 0 24 24",
    width: size,
    height: size,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    ...r
  }, Circle(7.5, 15.5, 4.5), React.createElement("path", {
    d: "M10.7 12.3 19 4M16 7l3 3M14 9l2 2"
  })),
  Globe: ({
    size = 18,
    ...r
  }) => React.createElement("svg", {
    viewBox: "0 0 24 24",
    width: size,
    height: size,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    ...r
  }, Circle(12, 12, 9), React.createElement("path", {
    d: "M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18"
  })),
  Leaf: I(["M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10z", "M2 21c0-3 1.85-5.36 5.08-6"]),
  Layers: I(["m12 2 9 5-9 5-9-5 9-5z", "m3 12 9 5 9-5", "m3 17 9 5 9-5"]),
  Check: I(["M20 6 9 17l-5-5"]),
  Copy: ({
    size = 18,
    ...r
  }) => React.createElement("svg", {
    viewBox: "0 0 24 24",
    width: size,
    height: size,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    ...r
  }, React.createElement("rect", {
    x: 9,
    y: 9,
    width: 12,
    height: 12,
    rx: 2
  }), React.createElement("path", {
    d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
  })),
  Trash: I(["M3 6h18", "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"]),
  Logout: I(["M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4", "m16 17 5-5-5-5", "M21 12H9"]),
  Settings: ({
    size = 18,
    ...r
  }) => React.createElement("svg", {
    viewBox: "0 0 24 24",
    width: size,
    height: size,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    ...r
  }, Circle(12, 12, 3), React.createElement("path", {
    d: "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
  })),
  Mail: ({
    size = 18,
    ...r
  }) => React.createElement("svg", {
    viewBox: "0 0 24 24",
    width: size,
    height: size,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    ...r
  }, React.createElement("rect", {
    x: 2,
    y: 4,
    width: 20,
    height: 16,
    rx: 2
  }), React.createElement("path", {
    d: "m2 7 10 6 10-6"
  })),
  Clock: ({
    size = 18,
    ...r
  }) => React.createElement("svg", {
    viewBox: "0 0 24 24",
    width: size,
    height: size,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    ...r
  }, Circle(12, 12, 9), React.createElement("path", {
    d: "M12 7v5l3 2"
  })),
  Dollar: I(["M12 2v20", "M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"])
};
window.VxIcons = Icons;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/vertex-app/icons.jsx", error: String((e && e.message) || e) }); }

// ui_kits/vertex-app/screens.jsx
try { (() => {
/* Alethia App UI kit — screen content. */
const S_VX = window.VertexDesignSystem_8c015f;
const {
  Button: SBtn,
  Badge: SBadge,
  StatusBadge: SStatus,
  Card: SCard,
  CardHeader: SCH,
  CardTitle: SCT,
  CardDescription: SCD,
  CardBody: SCB,
  CardFooter: SCF,
  Input: SInput,
  Field: SField,
  Label: SLabel,
  Hint: SHint,
  Select: SSelect,
  Switch: SSwitch,
  Checkbox: SCheck,
  Radio: SRadio,
  Tabs: STabs,
  Separator: SSep,
  Alert: SAlert
} = S_VX;
const SIc = window.VxIcons;
const {
  Provider: SProvider
} = window.VxApp;
const eb = window.VxApp.eyebrow,
  mn = window.VxApp.mono;
const PageHead = ({
  title,
  sub,
  action
}) => /*#__PURE__*/React.createElement("div", {
  style: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    marginBottom: 26
  }
}, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h1", {
  style: {
    fontFamily: "var(--font-display)",
    fontSize: 24,
    fontWeight: 600,
    letterSpacing: "-0.02em",
    margin: 0,
    color: "var(--text-primary)"
  }
}, title), /*#__PURE__*/React.createElement("p", {
  style: {
    color: "var(--text-tertiary)",
    fontSize: 14,
    margin: "6px 0 0"
  }
}, sub)), action);
const SectionLabel = ({
  children,
  right
}) => /*#__PURE__*/React.createElement("div", {
  style: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12
  }
}, /*#__PURE__*/React.createElement("span", {
  style: eb
}, children), right);

/* ---------- Overview ---------- */
function Overview() {
  const stats = [["Leaf", 6, "Vines"], ["Check", 4, "Active"], ["Workflow", 2, "Tendrils online"], ["Jobs", 38, "Total jobs"]];
  const jobs = [["Deploy", "active", "api-backend", "aws", "prod-worker", "2m ago", "12m 34s"], ["Plan", "active", "web-frontend", "gcp", "prod-worker", "18m ago", "1m 12s"], ["Deploy", "processing", "data-pipeline", "azure", "eu-worker", "24m ago", "4m 02s"], ["Destroy", "failed", "legacy-api", "aws", "prod-worker", "1h ago", "3m 41s"], ["Fetch Resources", "queued", "—", null, "eu-worker", "1h ago", "—"]];
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(PageHead, {
    title: "Overview",
    sub: "Your infrastructure at a glance.",
    action: /*#__PURE__*/React.createElement(SBtn, {
      variant: "primary",
      size: "sm"
    }, /*#__PURE__*/React.createElement(SIc.Plus, {
      size: 15
    }), "Plant a Vine")
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "repeat(4,1fr)",
      gap: 12,
      marginBottom: 30
    }
  }, stats.map(([ic, val, label]) => {
    const I = SIc[ic];
    return /*#__PURE__*/React.createElement("div", {
      key: label,
      style: {
        display: "flex",
        alignItems: "center",
        gap: 12,
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-md)",
        padding: "12px 14px",
        background: "var(--surface)"
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        display: "grid",
        placeItems: "center",
        width: 30,
        height: 30,
        borderRadius: "var(--radius-sm)",
        background: "var(--surface-muted)",
        color: "var(--text-secondary)"
      }
    }, /*#__PURE__*/React.createElement(I, {
      size: 15
    })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("p", {
      style: {
        margin: 0,
        fontSize: 20,
        fontWeight: 600,
        letterSpacing: "-0.02em",
        fontFamily: "var(--font-display)",
        color: "var(--text-primary)"
      }
    }, val), /*#__PURE__*/React.createElement("p", {
      style: {
        margin: 0,
        fontSize: 11,
        color: "var(--text-tertiary)"
      }
    }, label)));
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 30
    }
  }, /*#__PURE__*/React.createElement(SectionLabel, {
    right: /*#__PURE__*/React.createElement(SBtn, {
      variant: "link",
      size: "sm",
      style: {
        fontSize: 11,
        color: "var(--text-tertiary)"
      }
    }, "Manage")
  }, "Integrations"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexWrap: "wrap",
      gap: 8
    }
  }, [["aws", "AWS", "acct 4471-…"], ["gcp", "GCP", "vertex-prod"]].map(([id, n, d]) => /*#__PURE__*/React.createElement("span", {
    key: id,
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      padding: "6px 12px",
      borderRadius: 999,
      border: "1px solid var(--border)",
      background: "var(--surface)",
      fontSize: 12
    }
  }, /*#__PURE__*/React.createElement(SProvider, {
    id: id,
    size: 15
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 500,
      color: "var(--text-primary)"
    }
  }, n), /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--text-tertiary)",
      ...mn,
      fontSize: 11
    }
  }, d))), [["azure", "Azure"], ["datadog", "Datadog"]].map(([id, n]) => /*#__PURE__*/React.createElement("span", {
    key: id,
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      padding: "6px 12px",
      borderRadius: 999,
      border: "1px dashed var(--border-strong)",
      fontSize: 12,
      color: "var(--text-tertiary)"
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: `../../assets/${id === "azure" ? "providers" : "integrations"}/${id}.png`,
    width: 14,
    height: 14,
    style: {
      objectFit: "contain",
      opacity: 0.6
    }
  }), /*#__PURE__*/React.createElement("span", null, n), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 10
    }
  }, "Connect"))))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(SectionLabel, {
    right: /*#__PURE__*/React.createElement(SBtn, {
      variant: "link",
      size: "sm",
      style: {
        fontSize: 11,
        color: "var(--text-tertiary)"
      }
    }, "View all")
  }, "Recent jobs"), /*#__PURE__*/React.createElement(JobsTable, {
    rows: jobs
  })));
}

/* ---------- Jobs table (shared) ---------- */
function JobsTable({
  rows
}) {
  const cols = ["Type", "Status", "Vine", "Tendril", "Created", "Duration"];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      border: "1px solid var(--border)",
      borderRadius: "var(--radius-md)",
      overflow: "hidden",
      background: "var(--surface)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "1.4fr 1fr 1.3fr 1fr 1fr 0.9fr",
      padding: "9px 16px",
      borderBottom: "1px solid var(--border)",
      background: "var(--surface-muted)"
    }
  }, cols.map(c => /*#__PURE__*/React.createElement("span", {
    key: c,
    style: {
      ...eb,
      fontSize: 9.5
    }
  }, c))), rows.map((r, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: "grid",
      gridTemplateColumns: "1.4fr 1fr 1.3fr 1fr 1fr 0.9fr",
      alignItems: "center",
      padding: "11px 16px",
      borderBottom: i < rows.length - 1 ? "1px solid var(--border-faint)" : "none"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12.5,
      fontWeight: 500,
      color: "var(--text-primary)"
    }
  }, r[0]), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement(SStatus, {
    status: r[1]
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 6,
      fontSize: 12,
      color: "var(--text-secondary)"
    }
  }, r[3] ? /*#__PURE__*/React.createElement(SProvider, {
    id: r[3],
    size: 14
  }) : null, r[2]), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: "var(--text-secondary)",
      ...mn
    }
  }, r[4]), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: "var(--text-tertiary)"
    }
  }, r[5]), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: "var(--text-tertiary)",
      ...mn
    }
  }, r[6]))));
}

/* ---------- Clusters ---------- */
function Clusters() {
  const data = [["api-backend", "aws", "EKS", "1.31", "eu-west-1", "active", 3, "$847"], ["web-frontend", "gcp", "GKE Autopilot", "1.30", "us-central1", "active", 5, "$612"], ["data-pipeline", "azure", "AKS", "1.30", "westeurope", "processing", 4, "$408"], ["ml-training", "aws", "EKS", "1.31", "us-east-1", "idle", 0, "$0"]];
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(PageHead, {
    title: "Clusters",
    sub: "Kubernetes clusters provisioned across every connected cloud.",
    action: /*#__PURE__*/React.createElement(SBtn, {
      variant: "outline",
      size: "sm"
    }, /*#__PURE__*/React.createElement(SIc.Plus, {
      size: 15
    }), "New cluster")
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: 16
    }
  }, data.map(([name, prov, kind, ver, region, status, nodes, cost]) => /*#__PURE__*/React.createElement(SCard, {
    key: name,
    interactive: true
  }, /*#__PURE__*/React.createElement(SCB, null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 11,
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: "grid",
      placeItems: "center",
      width: 34,
      height: 34,
      borderRadius: "var(--radius-sm)",
      border: "1px solid var(--border)",
      background: "var(--surface-muted)"
    }
  }, /*#__PURE__*/React.createElement(SProvider, {
    id: prov,
    size: 18
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("p", {
    style: {
      margin: 0,
      fontSize: 14,
      fontWeight: 600,
      fontFamily: "var(--font-display)",
      color: "var(--text-primary)"
    }
  }, name), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: 0,
      fontSize: 11.5,
      color: "var(--text-tertiary)",
      ...mn
    }
  }, kind, " \xB7 ", region)), /*#__PURE__*/React.createElement(SStatus, {
    status: status
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      flexWrap: "wrap"
    }
  }, /*#__PURE__*/React.createElement(SBadge, {
    variant: "outline",
    mono: true
  }, "k8s ", ver), /*#__PURE__*/React.createElement(SBadge, {
    variant: "muted"
  }, nodes, " ", nodes === 1 ? "node" : "nodes"), /*#__PURE__*/React.createElement(SBadge, {
    variant: "muted"
  }, cost, "/mo"))), /*#__PURE__*/React.createElement(SCF, {
    style: {
      borderTop: "1px solid var(--border-faint)",
      paddingTop: 12
    }
  }, /*#__PURE__*/React.createElement(SBtn, {
    variant: "outline",
    size: "sm"
  }, "Open"), /*#__PURE__*/React.createElement(SBtn, {
    variant: "ghost",
    size: "sm"
  }, "kubeconfig"))))));
}

/* ---------- Jobs ---------- */
function Jobs() {
  const [tab, setTab] = React.useState("all");
  const rows = [["Deploy", "active", "api-backend", "aws", "prod-worker", "2m ago", "12m 34s"], ["Plan", "active", "web-frontend", "gcp", "prod-worker", "18m ago", "1m 12s"], ["Deploy", "processing", "data-pipeline", "azure", "eu-worker", "24m ago", "4m 02s"], ["Connection Test", "active", "—", "gcp", "eu-worker", "40m ago", "8s"], ["Destroy", "failed", "legacy-api", "aws", "prod-worker", "1h ago", "3m 41s"], ["Fetch Resources", "queued", "—", null, "eu-worker", "1h ago", "—"], ["Deploy Tendril", "active", "—", "azure", "eu-worker", "3h ago", "2m 05s"]];
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(PageHead, {
    title: "Jobs",
    sub: "Every plan, deploy, and teardown across your vineyards."
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement(STabs, {
    variant: "pill",
    tabs: [{
      id: "all",
      label: "All"
    }, {
      id: "running",
      label: "Running"
    }, {
      id: "failed",
      label: "Failed"
    }],
    value: tab,
    onValueChange: setTab
  })), /*#__PURE__*/React.createElement(JobsTable, {
    rows: rows
  }));
}

/* ---------- Plant a Vine ---------- */
function PlantVine() {
  const [section, setSection] = React.useState("cluster");
  const sections = [["network", "Network", "Network"], ["cluster", "Cluster", "Cpu"], ["database", "Database", "Database"], ["cache", "Cache", "Layers"], ["dns", "DNS", "Globe"], ["secrets", "Secrets", "Key"]];
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(PageHead, {
    title: "Plant a Vine",
    sub: "Eleven guided sections compile into a single Terraform plan.",
    action: /*#__PURE__*/React.createElement(SBadge, {
      variant: "outline",
      mono: true
    }, "production \xB7 api-backend")
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "190px 1fr 240px",
      gap: 24,
      alignItems: "start"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 2
    }
  }, sections.map(([id, label, icon], i) => {
    const I = SIc[icon];
    const on = section === id;
    const done = i < sections.findIndex(s => s[0] === section);
    return /*#__PURE__*/React.createElement("button", {
      key: id,
      onClick: () => setSection(id),
      style: {
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 10px",
        borderRadius: "var(--radius-sm)",
        border: "none",
        cursor: "pointer",
        textAlign: "left",
        background: on ? "var(--surface-muted)" : "transparent",
        color: on ? "var(--text-primary)" : "var(--text-tertiary)",
        fontSize: 13,
        fontWeight: 500,
        fontFamily: "var(--font-sans)"
      }
    }, /*#__PURE__*/React.createElement(I, {
      size: 15
    }), label, done && /*#__PURE__*/React.createElement(SIc.Check, {
      size: 13,
      style: {
        marginLeft: "auto",
        color: "var(--text-secondary)"
      }
    }));
  })), /*#__PURE__*/React.createElement(SCard, null, /*#__PURE__*/React.createElement(SCH, null, /*#__PURE__*/React.createElement(SCT, null, "Cluster"), /*#__PURE__*/React.createElement(SCD, null, "Control plane, node pools, and autoscaling.")), /*#__PURE__*/React.createElement(SCB, {
    style: {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: 16
    }
  }, /*#__PURE__*/React.createElement(SField, null, /*#__PURE__*/React.createElement(SLabel, null, "Kubernetes version"), /*#__PURE__*/React.createElement(SSelect, {
    options: ["1.31", "1.30", "1.29"],
    defaultValue: "1.31"
  })), /*#__PURE__*/React.createElement(SField, null, /*#__PURE__*/React.createElement(SLabel, null, "Instance type"), /*#__PURE__*/React.createElement(SSelect, {
    options: ["m5.large", "m5.xlarge", "c6i.2xlarge"],
    defaultValue: "m5.large"
  })), /*#__PURE__*/React.createElement(SField, null, /*#__PURE__*/React.createElement(SLabel, null, "Min nodes"), /*#__PURE__*/React.createElement(SInput, {
    mono: true,
    defaultValue: "2"
  })), /*#__PURE__*/React.createElement(SField, null, /*#__PURE__*/React.createElement(SLabel, null, "Max nodes"), /*#__PURE__*/React.createElement(SInput, {
    mono: true,
    defaultValue: "10"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      gridColumn: "1 / -1",
      display: "flex",
      flexDirection: "column",
      gap: 12,
      marginTop: 4
    }
  }, /*#__PURE__*/React.createElement("label", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10,
      fontSize: 13,
      color: "var(--text-secondary)"
    }
  }, /*#__PURE__*/React.createElement(SSwitch, {
    defaultChecked: true
  }), " Karpenter autoscaling"), /*#__PURE__*/React.createElement("label", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10,
      fontSize: 13,
      color: "var(--text-secondary)"
    }
  }, /*#__PURE__*/React.createElement(SSwitch, {
    defaultChecked: true
  }), " ArgoCD bootstrap (GitOps)"), /*#__PURE__*/React.createElement("label", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10,
      fontSize: 13,
      color: "var(--text-secondary)"
    }
  }, /*#__PURE__*/React.createElement(SSwitch, null), " Private API endpoint only"))), /*#__PURE__*/React.createElement(SCF, {
    style: {
      justifyContent: "space-between",
      borderTop: "1px solid var(--border-faint)",
      paddingTop: 14
    }
  }, /*#__PURE__*/React.createElement(SBtn, {
    variant: "ghost",
    size: "sm"
  }, "Back"), /*#__PURE__*/React.createElement(SBtn, {
    variant: "primary",
    size: "sm"
  }, "Continue", /*#__PURE__*/React.createElement(SIc.ArrowRight, {
    size: 15
  })))), /*#__PURE__*/React.createElement("div", {
    style: {
      position: "sticky",
      top: 0,
      display: "flex",
      flexDirection: "column",
      gap: 14
    }
  }, /*#__PURE__*/React.createElement(SCard, {
    flat: true,
    style: {
      background: "var(--surface-muted)"
    }
  }, /*#__PURE__*/React.createElement(SCB, null, /*#__PURE__*/React.createElement("p", {
    style: {
      ...eb,
      margin: "0 0 12px"
    }
  }, "Estimated monthly"), /*#__PURE__*/React.createElement("p", {
    style: {
      fontFamily: "var(--font-display)",
      fontSize: 30,
      fontWeight: 600,
      letterSpacing: "-0.03em",
      margin: 0,
      color: "var(--text-primary)"
    }
  }, "$847", /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 16,
      color: "var(--text-tertiary)"
    }
  }, ".23")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 8,
      marginTop: 16
    }
  }, [["EKS cluster", "$219"], ["Aurora DB", "$412"], ["ElastiCache", "$156"], ["NAT + DNS", "$33"], ["Other", "$27"]].map(([k, v]) => /*#__PURE__*/React.createElement("div", {
    key: k,
    style: {
      display: "flex",
      justifyContent: "space-between",
      fontSize: 12
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--text-tertiary)"
    }
  }, k), /*#__PURE__*/React.createElement("span", {
    style: {
      ...mn,
      color: "var(--text-secondary)"
    }
  }, v)))))), /*#__PURE__*/React.createElement(SAlert, {
    title: "Zero credentials stored",
    icon: /*#__PURE__*/React.createElement(SIc.Shield, {
      size: 16
    })
  }, "Provisioned via a cross-account IAM role."))));
}

/* ---------- Integrations ---------- */
function Integrations() {
  const items = [["aws", "providers", "AWS", "Cross-account IAM role", true], ["gcp", "providers", "Google Cloud", "Workload Identity Federation", true], ["azure", "providers", "Azure", "Federated identity", false], ["github", "integrations", "GitHub", "Repository sync & GitOps", true], ["datadog", "integrations", "Datadog", "Metrics & monitoring", false], ["grafana", "integrations", "Grafana", "Dashboards", false], ["cloudflare", "integrations", "Cloudflare", "DNS & WAF", false], ["prometheus", "integrations", "Prometheus", "Scrape targets", false]];
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(PageHead, {
    title: "Integrations",
    sub: "Connect cloud accounts and tooling. No static keys are ever stored."
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "1fr 1fr 1fr",
      gap: 14
    }
  }, items.map(([id, dir, name, desc, connected]) => /*#__PURE__*/React.createElement(SCard, {
    key: id,
    interactive: true
  }, /*#__PURE__*/React.createElement(SCB, null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10,
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: "grid",
      placeItems: "center",
      width: 32,
      height: 32,
      borderRadius: "var(--radius-sm)",
      border: "1px solid var(--border)",
      background: "var(--surface-muted)"
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: `../../assets/${dir}/${id}.png`,
    width: 18,
    height: 18,
    style: {
      objectFit: "contain"
    }
  })), connected ? /*#__PURE__*/React.createElement(SStatus, {
    status: "active"
  }, "Connected") : null), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: "0 0 3px",
      fontSize: 14,
      fontWeight: 600,
      fontFamily: "var(--font-display)",
      color: "var(--text-primary)"
    }
  }, name), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: "0 0 16px",
      fontSize: 12,
      color: "var(--text-tertiary)",
      lineHeight: 1.4
    }
  }, desc), /*#__PURE__*/React.createElement(SBtn, {
    variant: connected ? "ghost" : "outline",
    size: "sm",
    style: {
      width: "100%"
    }
  }, connected ? "Manage" : "Connect"))))));
}

/* ---------- Tendrils ---------- */
function Tendrils() {
  const rows = [["prod-worker", "active", "AWS · eu-west-1", "cloud-hosted", "v1.4.2", "47 jobs"], ["eu-worker", "active", "Azure · westeurope", "self-hosted", "v1.4.2", "23 jobs"], ["staging-worker", "idle", "GCP · us-central1", "self-hosted", "v1.3.9", "8 jobs"]];
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(PageHead, {
    title: "Tendrils",
    sub: "Provisioning workers that claim jobs and run Terraform.",
    action: /*#__PURE__*/React.createElement(SBtn, {
      variant: "outline",
      size: "sm"
    }, /*#__PURE__*/React.createElement(SIc.Plus, {
      size: 15
    }), "Register tendril")
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      border: "1px solid var(--border)",
      borderRadius: "var(--radius-md)",
      overflow: "hidden",
      background: "var(--surface)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "1.2fr 1fr 1.4fr 1fr 0.8fr 0.8fr",
      padding: "9px 16px",
      borderBottom: "1px solid var(--border)",
      background: "var(--surface-muted)"
    }
  }, ["Tendril", "Status", "Region", "Mode", "Version", "Throughput"].map(c => /*#__PURE__*/React.createElement("span", {
    key: c,
    style: {
      ...eb,
      fontSize: 9.5
    }
  }, c))), rows.map((r, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: "grid",
      gridTemplateColumns: "1.2fr 1fr 1.4fr 1fr 0.8fr 0.8fr",
      alignItems: "center",
      padding: "12px 16px",
      borderBottom: i < rows.length - 1 ? "1px solid var(--border-faint)" : "none"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13,
      fontWeight: 500,
      color: "var(--text-primary)",
      ...mn
    }
  }, r[0]), /*#__PURE__*/React.createElement(SStatus, {
    status: r[1]
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: "var(--text-secondary)"
    }
  }, r[2]), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement(SBadge, {
    variant: "muted"
  }, r[3])), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: "var(--text-tertiary)",
      ...mn
    }
  }, r[4]), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: "var(--text-tertiary)"
    }
  }, r[5])))));
}
window.VxScreens = {
  Overview,
  Clusters,
  Jobs,
  PlantVine,
  Integrations,
  Tendrils
};
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/vertex-app/screens.jsx", error: String((e && e.message) || e) }); }

// ui_kits/vertex-app/shell.jsx
try { (() => {
/* Alethia App UI kit — interactive control-plane recreation.
   Composes the Alethia design-system primitives (window.VertexDesignSystem_8c015f). */
const VX = window.VertexDesignSystem_8c015f;
const {
  Button,
  Badge,
  StatusBadge,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardBody,
  CardFooter,
  Input,
  Field,
  Label,
  Hint,
  Select,
  Switch,
  Checkbox,
  Radio,
  Tabs,
  Avatar,
  Separator,
  Alert,
  Spinner
} = VX;
const Ic = window.VxIcons;
const Mark = ({
  size = 24
}) => /*#__PURE__*/React.createElement("svg", {
  width: size,
  height: size,
  viewBox: "0 0 32 32",
  fill: "none",
  style: {
    display: "block",
    flexShrink: 0
  }
}, /*#__PURE__*/React.createElement("path", {
  d: "M4 25.5 L16 6 L28 25.5",
  stroke: "currentColor",
  strokeWidth: "3",
  strokeLinejoin: "round",
  strokeLinecap: "round"
}), /*#__PURE__*/React.createElement("path", {
  d: "M10.5 25.5 L16 16.5 L21.5 25.5",
  stroke: "currentColor",
  strokeWidth: "3",
  strokeLinejoin: "round",
  strokeLinecap: "round",
  opacity: "0.4"
}), /*#__PURE__*/React.createElement("rect", {
  x: "13.4",
  y: "3.4",
  width: "5.2",
  height: "5.2",
  rx: "1.1",
  transform: "rotate(45 16 6)",
  fill: "currentColor"
}));
const Provider = ({
  id,
  size = 18
}) => /*#__PURE__*/React.createElement("img", {
  src: `../../assets/providers/${id}.png`,
  alt: id,
  width: size,
  height: size,
  style: {
    objectFit: "contain",
    display: "block"
  }
});
const eyebrow = {
  fontFamily: "var(--font-mono)",
  fontSize: "10px",
  letterSpacing: "0.16em",
  textTransform: "uppercase",
  color: "var(--text-tertiary)"
};
const mono = {
  fontFamily: "var(--font-mono)"
};

/* ---------------- Sign in ---------------- */
function SignIn({
  onAuth
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      minHeight: "100%",
      display: "grid",
      placeItems: "center",
      padding: "40px 20px",
      background: "var(--canvas)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: "100%",
      maxWidth: 380
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: 18,
      marginBottom: 28,
      color: "var(--text-primary)"
    }
  }, /*#__PURE__*/React.createElement(Mark, {
    size: 40
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center"
    }
  }, /*#__PURE__*/React.createElement("h1", {
    style: {
      fontFamily: "var(--font-display)",
      fontSize: 24,
      fontWeight: 600,
      letterSpacing: "-0.02em",
      margin: 0
    }
  }, "Sign in to Alethia"), /*#__PURE__*/React.createElement("p", {
    style: {
      color: "var(--text-tertiary)",
      fontSize: 14,
      margin: "6px 0 0"
    }
  }, "Configure infrastructure. Deploy from the terminal."))), /*#__PURE__*/React.createElement(Card, null, /*#__PURE__*/React.createElement(CardBody, {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 8
    }
  }, [["github", "GitHub"], ["gitlab", "GitLab"], ["bitbucket", "Bitbucket"]].map(([id, name]) => /*#__PURE__*/React.createElement(Button, {
    key: id,
    variant: "outline",
    onClick: onAuth,
    style: {
      width: "100%",
      height: 40,
      fontWeight: 400
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: `../../assets/integrations/${id}.png`,
    width: 16,
    height: 16,
    alt: "",
    style: {
      objectFit: "contain"
    }
  }), "Continue with ", name)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 12,
      padding: "6px 0"
    }
  }, /*#__PURE__*/React.createElement(Separator, null), /*#__PURE__*/React.createElement("span", {
    style: {
      ...eyebrow
    }
  }, "or"), /*#__PURE__*/React.createElement(Separator, null)), /*#__PURE__*/React.createElement(Field, null, /*#__PURE__*/React.createElement(Input, {
    placeholder: "name@example.com",
    defaultValue: ""
  })), /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    onClick: onAuth,
    style: {
      width: "100%",
      height: 40
    }
  }, /*#__PURE__*/React.createElement(Ic.Mail, {
    size: 16
  }), "Send magic link"))), /*#__PURE__*/React.createElement("p", {
    style: {
      ...eyebrow,
      textAlign: "center",
      marginTop: 20
    }
  }, "Zero credentials stored \xB7 SOC-2 aligned")));
}

/* ---------------- Shell ---------------- */
const NAV = [["overview", "Overview", "Dashboard"], ["plant", "Plant a Vine", "Plus"], ["clusters", "Clusters", "Server"], ["jobs", "Jobs", "Jobs"], ["integrations", "Integrations", "Blocks"], ["tendrils", "Tendrils", "Workflow"]];
const TITLES = {
  overview: "Overview",
  plant: "Plant a Vine",
  clusters: "Clusters",
  jobs: "Jobs",
  integrations: "Integrations",
  tendrils: "Tendrils"
};
function Sidebar({
  active,
  setActive,
  onLogout
}) {
  return /*#__PURE__*/React.createElement("aside", {
    style: {
      width: "var(--sidebar-w)",
      flexShrink: 0,
      display: "flex",
      flexDirection: "column",
      borderRight: "1px solid var(--border)",
      background: "color-mix(in oklch, var(--canvas) 60%, var(--surface))"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      height: "var(--header-h)",
      display: "flex",
      alignItems: "center",
      gap: 9,
      padding: "0 18px",
      borderBottom: "1px solid var(--border)",
      color: "var(--text-primary)"
    }
  }, /*#__PURE__*/React.createElement(Mark, {
    size: 22
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-display)",
      fontSize: 17,
      fontWeight: 600,
      letterSpacing: "-0.01em"
    }
  }, "Alethia"), /*#__PURE__*/React.createElement(Badge, {
    variant: "outline",
    mono: true,
    style: {
      marginLeft: "auto",
      fontSize: 9
    }
  }, "v1.4")), /*#__PURE__*/React.createElement("nav", {
    style: {
      flex: 1,
      padding: 12,
      display: "flex",
      flexDirection: "column",
      gap: 2,
      overflowY: "auto"
    }
  }, NAV.map(([id, label, icon]) => {
    const Icon = Ic[icon];
    const on = active === id;
    return /*#__PURE__*/React.createElement("button", {
      key: id,
      onClick: () => setActive(id),
      style: {
        display: "flex",
        alignItems: "center",
        gap: 10,
        height: 34,
        padding: "0 10px",
        borderRadius: "var(--radius-sm)",
        border: "none",
        cursor: "pointer",
        textAlign: "left",
        width: "100%",
        fontFamily: "var(--font-sans)",
        fontSize: 13,
        fontWeight: 500,
        background: on ? "var(--surface-muted)" : "transparent",
        color: on ? "var(--text-primary)" : "var(--text-tertiary)",
        transition: "background var(--duration-fast), color var(--duration-fast)"
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      size: 16
    }), label);
  }), /*#__PURE__*/React.createElement("p", {
    style: {
      ...eyebrow,
      margin: "18px 10px 8px"
    }
  }, "Vineyards"), [["production", "active"], ["staging", "active"], ["sandbox", "idle"]].map(([v, s]) => /*#__PURE__*/React.createElement("button", {
    key: v,
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10,
      height: 30,
      padding: "0 10px",
      borderRadius: "var(--radius-sm)",
      border: "none",
      background: "transparent",
      cursor: "pointer",
      width: "100%",
      color: "var(--text-tertiary)",
      fontFamily: "var(--font-mono)",
      fontSize: 12
    }
  }, /*#__PURE__*/React.createElement(StatusBadge, {
    status: s,
    showLabel: false
  }), v))), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 12,
      borderTop: "1px solid var(--border)"
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: onLogout,
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10,
      padding: 8,
      borderRadius: "var(--radius-sm)",
      width: "100%",
      border: "1px solid transparent",
      background: "transparent",
      cursor: "pointer",
      textAlign: "left"
    },
    title: "Sign out"
  }, /*#__PURE__*/React.createElement(Avatar, {
    initials: "BB",
    size: 30
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      minWidth: 0,
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("p", {
    style: {
      margin: 0,
      fontSize: 13,
      fontWeight: 500,
      color: "var(--text-primary)"
    }
  }, "Borislav B."), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: 0,
      fontSize: 11,
      color: "var(--text-tertiary)",
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis"
    }
  }, "bobi@alethia.dev")), /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--text-tertiary)"
    }
  }, /*#__PURE__*/React.createElement(Ic.Logout, {
    size: 15
  })))));
}
function TopBar({
  active
}) {
  return /*#__PURE__*/React.createElement("header", {
    style: {
      height: "var(--header-h)",
      flexShrink: 0,
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "0 24px",
      borderBottom: "1px solid var(--border)",
      background: "color-mix(in oklch, var(--canvas) 80%, transparent)",
      backdropFilter: "blur(8px)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      ...mono,
      fontSize: 12,
      color: "var(--text-tertiary)"
    }
  }, /*#__PURE__*/React.createElement("span", null, "vertex"), /*#__PURE__*/React.createElement(Ic.ChevronRight, {
    size: 13
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--text-primary)"
    }
  }, TITLES[active])), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 6
    }
  }, /*#__PURE__*/React.createElement(Button, {
    variant: "ghost",
    size: "sm",
    icon: true,
    "aria-label": "Search"
  }, /*#__PURE__*/React.createElement(Ic.Search, {
    size: 16
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      position: "relative"
    }
  }, /*#__PURE__*/React.createElement(Button, {
    variant: "ghost",
    size: "sm",
    icon: true,
    "aria-label": "Notifications"
  }, /*#__PURE__*/React.createElement(Ic.Bell, {
    size: 16
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      position: "absolute",
      top: 6,
      right: 6,
      width: 6,
      height: 6,
      borderRadius: 999,
      background: "var(--text-primary)"
    }
  })), /*#__PURE__*/React.createElement(Separator, {
    orientation: "vertical",
    style: {
      height: 20,
      margin: "0 4px"
    }
  }), /*#__PURE__*/React.createElement(Avatar, {
    initials: "BB",
    size: 28
  })));
}
window.VxApp = {
  SignIn,
  Sidebar,
  TopBar,
  Mark,
  Provider,
  eyebrow,
  mono,
  Ic,
  VX
};
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/vertex-app/shell.jsx", error: String((e && e.message) || e) }); }

// ui_kits/vertex-web/sections.jsx
try { (() => {
/* Alethia Web UI kit — marketing landing recreation. */
const W = window.VertexDesignSystem_8c015f;
const {
  Button: WBtn,
  Badge: WBadge,
  Tabs: WTabs,
  Card: WCard,
  CardBody: WCB,
  Separator: WSep
} = W;
const WMark = ({
  size = 26
}) => /*#__PURE__*/React.createElement("svg", {
  width: size,
  height: size,
  viewBox: "0 0 32 32",
  fill: "none",
  style: {
    display: "block"
  }
}, /*#__PURE__*/React.createElement("path", {
  d: "M4 25.5 L16 6 L28 25.5",
  stroke: "currentColor",
  strokeWidth: "3",
  strokeLinejoin: "round",
  strokeLinecap: "round"
}), /*#__PURE__*/React.createElement("path", {
  d: "M10.5 25.5 L16 16.5 L21.5 25.5",
  stroke: "currentColor",
  strokeWidth: "3",
  strokeLinejoin: "round",
  strokeLinecap: "round",
  opacity: "0.4"
}), /*#__PURE__*/React.createElement("rect", {
  x: "13.4",
  y: "3.4",
  width: "5.2",
  height: "5.2",
  rx: "1.1",
  transform: "rotate(45 16 6)",
  fill: "currentColor"
}));
const Arrow = ({
  size = 15
}) => /*#__PURE__*/React.createElement("svg", {
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "2",
  strokeLinecap: "round",
  strokeLinejoin: "round"
}, /*#__PURE__*/React.createElement("path", {
  d: "M5 12h14m-6-6 6 6-6 6"
}));
const ebw = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  letterSpacing: "0.16em",
  textTransform: "uppercase",
  color: "var(--text-tertiary)"
};
const wmono = {
  fontFamily: "var(--font-mono)"
};
const Wrap = ({
  children,
  style
}) => /*#__PURE__*/React.createElement("div", {
  style: {
    maxWidth: 1080,
    margin: "0 auto",
    padding: "0 32px",
    ...style
  }
}, children);

/* ---- Header ---- */
function Header() {
  const links = ["Features", "CLI", "Ecosystem", "Docs"];
  return /*#__PURE__*/React.createElement("header", {
    style: {
      position: "sticky",
      top: 0,
      zIndex: 40,
      borderBottom: "1px solid var(--border)",
      background: "color-mix(in oklch, var(--canvas) 82%, transparent)",
      backdropFilter: "blur(10px)"
    }
  }, /*#__PURE__*/React.createElement(Wrap, {
    style: {
      height: 60,
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 9,
      color: "var(--text-primary)"
    }
  }, /*#__PURE__*/React.createElement(WMark, {
    size: 24
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-display)",
      fontSize: 18,
      fontWeight: 600,
      letterSpacing: "-0.01em"
    }
  }, "Alethia"), /*#__PURE__*/React.createElement("span", {
    style: {
      ...ebw,
      fontSize: 9,
      marginLeft: 6,
      opacity: 0.7
    }
  }, "by Alethia")), /*#__PURE__*/React.createElement("nav", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 4
    }
  }, links.map(l => /*#__PURE__*/React.createElement("a", {
    key: l,
    href: "#",
    style: {
      padding: "6px 12px",
      fontSize: 13.5,
      color: "var(--text-tertiary)",
      borderRadius: "var(--radius-sm)"
    }
  }, l))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("a", {
    href: "#",
    style: {
      display: "flex",
      alignItems: "center",
      gap: 7,
      fontSize: 13.5,
      color: "var(--text-tertiary)"
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: "../../assets/integrations/github.png",
    width: 16,
    height: 16,
    style: {
      filter: "grayscale(1) invert(0.85)"
    }
  }), "GitHub"), /*#__PURE__*/React.createElement(WBtn, {
    variant: "primary",
    size: "sm"
  }, "Get started"))));
}

/* ---- Terminal demo ---- */
const DEMO = {
  aws: {
    plan: ["$ vertex plan", "", "  ▸ Terraform plan…", "  47 resources to add", "  0 to change, 0 to destroy", "", "  Estimated  $847.23/mo"],
    deploy: ["$ vertex deploy", "", "  ✓ aws_vpc.main", "  ✓ aws_eks_cluster.main   v1.31", "  ✓ aws_rds_cluster.main    aurora", "  ✓ helm_release.argocd     v2.12", "  … +43 more", "  ✓ Apply complete · 12m 34s"],
    cost: ["$ vertex cost", "", "  EKS cluster   ████████   $219", "  Aurora DB     ██████████ $412", "  ElastiCache   ██████     $156", "  NAT + DNS     ██          $33", "  ─────────────────────────────", "  Total                $847/mo"]
  },
  gcp: {
    plan: ["$ vertex plan", "", "  ▸ Terraform plan…", "  39 resources to add", "  0 to change, 0 to destroy", "", "  Estimated  $612.00/mo"],
    deploy: ["$ vertex deploy", "", "  ✓ google_compute_network.main", "  ✓ google_container_cluster.main", "  ✓ google_sql_database_instance", "  ✓ helm_release.argocd", "  … +29 more", "  ✓ Apply complete · 9m 51s"],
    cost: ["$ vertex cost", "", "  GKE Autopilot ████████   $241", "  Cloud SQL     █████████  $298", "  Memorystore   ████       $128", "  Other         ██          $45", "  ─────────────────────────────", "  Total                $612/mo"]
  },
  azure: {
    plan: ["$ vertex plan", "", "  ▸ Terraform plan…", "  41 resources to add", "  0 to change, 0 to destroy", "", "  Estimated  $408.00/mo"],
    deploy: ["$ vertex deploy", "", "  ✓ azurerm_virtual_network.main", "  ✓ azurerm_kubernetes_cluster", "  ✓ azurerm_postgresql_flexible", "  ✓ helm_release.argocd", "  … +31 more", "  ✓ Apply complete · 11m 08s"],
    cost: ["$ vertex cost", "", "  AKS           ███████    $198", "  Azure PG      ████████   $142", "  Redis         ████        $52", "  Other         █           $16", "  ─────────────────────────────", "  Total                $408/mo"]
  }
};
function Terminal() {
  const [prov, setProv] = React.useState("aws");
  const [tab, setTab] = React.useState("deploy");
  const lines = DEMO[prov][tab];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      border: "1px solid var(--border)",
      borderRadius: "var(--radius-xl)",
      overflow: "hidden",
      background: "var(--surface)",
      boxShadow: "var(--shadow-lg)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "10px 14px",
      borderBottom: "1px solid var(--border)",
      background: "var(--surface-muted)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 6
    }
  }, [0, 1, 2].map(i => /*#__PURE__*/React.createElement("span", {
    key: i,
    style: {
      width: 10,
      height: 10,
      borderRadius: 999,
      border: "1px solid var(--border-strong)"
    }
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 4
    }
  }, ["aws", "gcp", "azure"].map(p => /*#__PURE__*/React.createElement("button", {
    key: p,
    onClick: () => setProv(p),
    style: {
      display: "flex",
      alignItems: "center",
      gap: 6,
      padding: "4px 9px",
      borderRadius: "var(--radius-sm)",
      border: "1px solid " + (prov === p ? "var(--border-strong)" : "transparent"),
      background: prov === p ? "var(--surface)" : "transparent",
      cursor: "pointer",
      fontSize: 11,
      color: "var(--text-secondary)",
      ...wmono
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: `../../assets/providers/${p}.png`,
    width: 13,
    height: 13,
    style: {
      objectFit: "contain"
    }
  }), p.toUpperCase())))), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "10px 14px",
      borderBottom: "1px solid var(--border-faint)"
    }
  }, /*#__PURE__*/React.createElement(WTabs, {
    variant: "pill",
    tabs: [{
      id: "plan",
      label: "Plan"
    }, {
      id: "deploy",
      label: "Deploy"
    }, {
      id: "cost",
      label: "Cost"
    }],
    value: tab,
    onValueChange: setTab
  })), /*#__PURE__*/React.createElement("pre", {
    style: {
      margin: 0,
      padding: "18px 20px",
      ...wmono,
      fontSize: 13,
      lineHeight: 1.75,
      color: "var(--text-secondary)",
      minHeight: 220,
      whiteSpace: "pre-wrap"
    }
  }, lines.map((l, i) => {
    const strong = l.startsWith("  ✓") || l.includes("Total") || l.includes("complete");
    const dim = l.startsWith("$") || l.startsWith("  ▸");
    return /*#__PURE__*/React.createElement("div", {
      key: i,
      style: {
        color: strong ? "var(--text-primary)" : dim ? "var(--text-tertiary)" : "var(--text-secondary)"
      }
    }, l || "\u00a0");
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      display: "inline-block",
      width: 8,
      height: 15,
      background: "var(--text-primary)",
      verticalAlign: "middle",
      animation: "vertex-blink 1.4s linear infinite"
    }
  })));
}

/* ---- Hero ---- */
function Hero() {
  const [copied, setCopied] = React.useState(false);
  const stats = [["3", "Cloud providers"], ["11", "Config sections"], ["16", "CLI commands"], ["0", "Stored credentials"]];
  return /*#__PURE__*/React.createElement("section", {
    style: {
      position: "relative",
      paddingTop: 96,
      paddingBottom: 64
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      inset: 0,
      backgroundImage: "linear-gradient(var(--border-faint) 1px,transparent 1px),linear-gradient(90deg,var(--border-faint) 1px,transparent 1px)",
      backgroundSize: "44px 44px",
      maskImage: "radial-gradient(ellipse 70% 60% at 50% 0%, #000 40%, transparent 75%)",
      WebkitMaskImage: "radial-gradient(ellipse 70% 60% at 50% 0%, #000 40%, transparent 75%)",
      pointerEvents: "none"
    }
  }), /*#__PURE__*/React.createElement(Wrap, {
    style: {
      position: "relative",
      textAlign: "center",
      display: "flex",
      flexDirection: "column",
      alignItems: "center"
    }
  }, /*#__PURE__*/React.createElement(WBadge, {
    variant: "outline",
    mono: true,
    style: {
      marginBottom: 24,
      padding: "5px 12px",
      borderRadius: 999
    }
  }, "Open-source infrastructure platform"), /*#__PURE__*/React.createElement("h1", {
    style: {
      fontFamily: "var(--font-display)",
      fontSize: 60,
      fontWeight: 600,
      letterSpacing: "-0.04em",
      lineHeight: 1.04,
      margin: 0,
      maxWidth: 760,
      color: "var(--text-primary)"
    }
  }, "The infrastructure layer", /*#__PURE__*/React.createElement("br", null), /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--text-tertiary)"
    }
  }, "for cloud-native teams")), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 19,
      color: "var(--text-secondary)",
      maxWidth: 560,
      margin: "22px 0 32px",
      lineHeight: 1.5
    }
  }, "Configure multi-cloud Kubernetes visually. Deploy from the terminal. Zero credentials stored."), /*#__PURE__*/React.createElement("div", {
    onClick: () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    },
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 14,
      border: "1px solid var(--border)",
      borderRadius: "var(--radius-sm)",
      padding: "10px 16px",
      marginBottom: 44,
      cursor: "pointer",
      background: "var(--surface)"
    }
  }, /*#__PURE__*/React.createElement("code", {
    style: {
      ...wmono,
      fontSize: 14,
      color: "var(--text-primary)"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--text-tertiary)"
    }
  }, "$ "), "brew install vertex"), /*#__PURE__*/React.createElement("span", {
    style: {
      ...ebw,
      fontSize: 10
    }
  }, copied ? "Copied" : "Copy")), /*#__PURE__*/React.createElement("div", {
    style: {
      width: "100%",
      maxWidth: 760
    }
  }, /*#__PURE__*/React.createElement(Terminal, null)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "repeat(4,1fr)",
      gap: 24,
      width: "100%",
      maxWidth: 680,
      marginTop: 56
    }
  }, stats.map(([v, l]) => /*#__PURE__*/React.createElement("div", {
    key: l
  }, /*#__PURE__*/React.createElement("p", {
    style: {
      fontFamily: "var(--font-display)",
      fontSize: 34,
      fontWeight: 600,
      letterSpacing: "-0.03em",
      margin: 0,
      color: "var(--text-primary)"
    }
  }, v), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 12,
      color: "var(--text-tertiary)",
      margin: "2px 0 0"
    }
  }, l))))));
}

/* ---- Features ---- */
function Features() {
  const bullets = [["Network", "Visual configuration", "Eleven guided sections with real-time cost estimation — network, cluster, databases, caches, DNS, secrets, and more."], ["Shield", "Zero-credential security", "Cross-account IAM roles, Workload Identity Federation, federated identity. No static keys are ever stored."], ["GitBranch", "GitOps by default", "ArgoCD bootstrapped on every cluster. Git is the audit trail. Plan, review, apply — for every change."]];
  const Bicon = {
    Network: /*#__PURE__*/React.createElement("path", {
      d: "M9 3h6v4H9zM3 17h6v4H3zm12 0h6v4h-6zM12 7v4m0 0H6v6m6-6h6v6"
    }),
    Shield: /*#__PURE__*/React.createElement("path", {
      d: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"
    }),
    GitBranch: /*#__PURE__*/React.createElement("g", null, /*#__PURE__*/React.createElement("line", {
      x1: "6",
      y1: "3",
      x2: "6",
      y2: "15"
    }), /*#__PURE__*/React.createElement("circle", {
      cx: "18",
      cy: "6",
      r: "3"
    }), /*#__PURE__*/React.createElement("circle", {
      cx: "6",
      cy: "18",
      r: "3"
    }), /*#__PURE__*/React.createElement("path", {
      d: "M18 9a9 9 0 0 1-9 9"
    }))
  };
  return /*#__PURE__*/React.createElement("section", {
    style: {
      padding: "72px 0",
      borderTop: "1px solid var(--border)"
    }
  }, /*#__PURE__*/React.createElement(Wrap, null, /*#__PURE__*/React.createElement("p", {
    style: {
      ...ebw,
      marginBottom: 14
    }
  }, "Why Alethia"), /*#__PURE__*/React.createElement("h2", {
    style: {
      fontFamily: "var(--font-display)",
      fontSize: 34,
      fontWeight: 600,
      letterSpacing: "-0.03em",
      margin: "0 0 12px",
      maxWidth: 560,
      color: "var(--text-primary)"
    }
  }, "Everything you need to ship infrastructure"), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 15,
      color: "var(--text-tertiary)",
      maxWidth: 520,
      margin: "0 0 44px",
      lineHeight: 1.6
    }
  }, "A visual configuration form and a CLI that share the same state. Design in the browser, execute from the terminal, reconcile with GitOps."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "repeat(3,1fr)",
      gap: 22
    }
  }, bullets.map(([ic, title, desc]) => /*#__PURE__*/React.createElement("div", {
    key: title
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: "grid",
      placeItems: "center",
      width: 38,
      height: 38,
      borderRadius: "var(--radius-md)",
      border: "1px solid var(--border)",
      background: "var(--surface-muted)",
      color: "var(--text-primary)",
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement("svg", {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.75",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, Bicon[ic])), /*#__PURE__*/React.createElement("h3", {
    style: {
      fontSize: 15.5,
      fontWeight: 600,
      fontFamily: "var(--font-display)",
      margin: "0 0 7px",
      color: "var(--text-primary)"
    }
  }, title), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 13.5,
      color: "var(--text-tertiary)",
      lineHeight: 1.6,
      margin: 0
    }
  }, desc))))));
}

/* ---- Ecosystem / modules ---- */
function Ecosystem() {
  const mods = [["Alethia", "Web control plane", "Visual infrastructure configuration, job dashboard, real-time logs, cost estimation."], ["vertex-cli", "CLI + worker", "An interactive terminal wizard for plan, deploy, and teardown across clouds."]];
  return /*#__PURE__*/React.createElement("section", {
    style: {
      padding: "0 0 80px"
    }
  }, /*#__PURE__*/React.createElement(Wrap, null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: 16
    }
  }, mods.map(([t, sub, d]) => /*#__PURE__*/React.createElement(WCard, {
    key: t,
    interactive: true
  }, /*#__PURE__*/React.createElement(WCB, {
    style: {
      display: "flex",
      gap: 14
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: "grid",
      placeItems: "center",
      width: 40,
      height: 40,
      borderRadius: "var(--radius-md)",
      background: "var(--surface-muted)",
      color: "var(--text-primary)",
      flexShrink: 0
    }
  }, t === "Alethia" ? /*#__PURE__*/React.createElement(WMark, {
    size: 20
  }) : /*#__PURE__*/React.createElement("svg", {
    width: 20,
    height: 20,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.75",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, /*#__PURE__*/React.createElement("path", {
    d: "m4 17 6-6-6-6M12 19h8"
  }))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "baseline",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("h3", {
    style: {
      fontSize: 15,
      fontWeight: 600,
      fontFamily: "var(--font-display)",
      margin: 0,
      color: "var(--text-primary)"
    }
  }, t), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: "var(--text-tertiary)",
      ...wmono
    }
  }, sub)), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 13,
      color: "var(--text-tertiary)",
      lineHeight: 1.55,
      margin: "6px 0 0"
    }
  }, d)), /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: "auto",
      color: "var(--text-tertiary)"
    }
  }, /*#__PURE__*/React.createElement(Arrow, null))))))));
}

/* ---- Footer ---- */
function Footer() {
  const cols = [["Product", ["Features", "CLI", "Dashboard", "Ecosystem"]], ["Developers", ["Documentation", "GitHub", "CLI reference"]], ["Resources", ["Architecture", "User flows", "Changelog"]], ["Company", ["Alethia", "Open source", "Contributing"]]];
  return /*#__PURE__*/React.createElement("footer", {
    style: {
      borderTop: "1px solid var(--border)",
      padding: "56px 0 32px"
    }
  }, /*#__PURE__*/React.createElement(Wrap, null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "1.4fr repeat(4,1fr)",
      gap: 28,
      marginBottom: 44
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 9,
      color: "var(--text-primary)",
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement(WMark, {
    size: 22
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-display)",
      fontSize: 17,
      fontWeight: 600
    }
  }, "Alethia")), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 12.5,
      color: "var(--text-tertiary)",
      lineHeight: 1.6,
      maxWidth: 220,
      margin: 0
    }
  }, "Configure multi-cloud infrastructure in the browser. Deploy from the terminal.")), cols.map(([title, links]) => /*#__PURE__*/React.createElement("div", {
    key: title
  }, /*#__PURE__*/React.createElement("p", {
    style: {
      ...ebw,
      fontSize: 10,
      marginBottom: 14
    }
  }, title), /*#__PURE__*/React.createElement("ul", {
    style: {
      listStyle: "none",
      padding: 0,
      margin: 0,
      display: "flex",
      flexDirection: "column",
      gap: 9
    }
  }, links.map(l => /*#__PURE__*/React.createElement("li", {
    key: l
  }, /*#__PURE__*/React.createElement("a", {
    href: "#",
    style: {
      fontSize: 13,
      color: "var(--text-tertiary)"
    }
  }, l))))))), /*#__PURE__*/React.createElement(WSep, null), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      paddingTop: 22
    }
  }, /*#__PURE__*/React.createElement("p", {
    style: {
      ...ebw,
      fontSize: 10,
      margin: 0
    }
  }, "\xA9 2026 Alethia \xB7 Alethia Systems"), /*#__PURE__*/React.createElement("p", {
    style: {
      ...ebw,
      fontSize: 10,
      margin: 0
    }
  }, "Built on the ADP control plane \xB7 Open source"))));
}
function Site() {
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(Header, null), /*#__PURE__*/React.createElement(Hero, null), /*#__PURE__*/React.createElement(Features, null), /*#__PURE__*/React.createElement(Ecosystem, null), /*#__PURE__*/React.createElement(Footer, null));
}
window.VxSite = Site;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/vertex-web/sections.jsx", error: String((e && e.message) || e) }); }

__ds_ns.Badge = __ds_scope.Badge;

__ds_ns.Button = __ds_scope.Button;

__ds_ns.Kbd = __ds_scope.Kbd;

__ds_ns.Alert = __ds_scope.Alert;

__ds_ns.Spinner = __ds_scope.Spinner;

__ds_ns.StatusBadge = __ds_scope.StatusBadge;

__ds_ns.Checkbox = __ds_scope.Checkbox;

__ds_ns.Radio = __ds_scope.Radio;

__ds_ns.Field = __ds_scope.Field;

__ds_ns.Label = __ds_scope.Label;

__ds_ns.Hint = __ds_scope.Hint;

__ds_ns.Input = __ds_scope.Input;

__ds_ns.Textarea = __ds_scope.Textarea;

__ds_ns.Select = __ds_scope.Select;

__ds_ns.Switch = __ds_scope.Switch;

__ds_ns.Tabs = __ds_scope.Tabs;

__ds_ns.Avatar = __ds_scope.Avatar;

__ds_ns.Card = __ds_scope.Card;

__ds_ns.CardHeader = __ds_scope.CardHeader;

__ds_ns.CardTitle = __ds_scope.CardTitle;

__ds_ns.CardDescription = __ds_scope.CardDescription;

__ds_ns.CardBody = __ds_scope.CardBody;

__ds_ns.CardFooter = __ds_scope.CardFooter;

__ds_ns.Separator = __ds_scope.Separator;

})();

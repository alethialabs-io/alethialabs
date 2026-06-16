/* Alethia UI kit — compact Lucide-style icon set (1.75px stroke, round caps). */
const I = (paths, props = {}) => ({ size = 18, ...rest }) =>
  React.createElement(
    "svg",
    { viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round", ...props, ...rest },
    paths.map((d, i) => React.createElement("path", { key: i, d }))
  );

const Circle = (cx, cy, r) => React.createElement("circle", { key: "c" + cx + cy, cx, cy, r });

const Icons = {
  Dashboard: ({ size = 18, ...r }) => React.createElement("svg", { viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round", ...r }, React.createElement("rect", { x: 3, y: 3, width: 7, height: 9, rx: 1 }), React.createElement("rect", { x: 14, y: 3, width: 7, height: 5, rx: 1 }), React.createElement("rect", { x: 14, y: 12, width: 7, height: 9, rx: 1 }), React.createElement("rect", { x: 3, y: 16, width: 7, height: 5, rx: 1 })),
  Plus: I(["M12 5v14", "M5 12h14"]),
  Server: ({ size = 18, ...r }) => React.createElement("svg", { viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round", ...r }, React.createElement("rect", { x: 3, y: 4, width: 18, height: 7, rx: 1.5 }), React.createElement("rect", { x: 3, y: 13, width: 18, height: 7, rx: 1.5 }), React.createElement("path", { d: "M7 7.5h.01M7 16.5h.01" })),
  Jobs: ({ size = 18, ...r }) => React.createElement("svg", { viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round", ...r }, React.createElement("rect", { x: 8, y: 2, width: 8, height: 4, rx: 1 }), React.createElement("path", { d: "M9 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-3M9 12l2 2 4-4" })),
  Blocks: ({ size = 18, ...r }) => React.createElement("svg", { viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round", ...r }, React.createElement("rect", { x: 3, y: 3, width: 8, height: 8, rx: 1 }), React.createElement("rect", { x: 13, y: 3, width: 8, height: 8, rx: 1 }), React.createElement("rect", { x: 3, y: 13, width: 8, height: 8, rx: 1 }), React.createElement("rect", { x: 13, y: 13, width: 8, height: 8, rx: 1 })),
  Workflow: ({ size = 18, ...r }) => React.createElement("svg", { viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round", ...r }, React.createElement("rect", { x: 3, y: 3, width: 7, height: 7, rx: 1 }), React.createElement("rect", { x: 14, y: 14, width: 7, height: 7, rx: 1 }), React.createElement("path", { d: "M6.5 10v4a2 2 0 0 0 2 2H14" })),
  Bell: I(["M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9", "M10.3 21a1.94 1.94 0 0 0 3.4 0"]),
  Search: ({ size = 18, ...r }) => React.createElement("svg", { viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round", ...r }, Circle(11, 11, 7), React.createElement("path", { d: "m21 21-4.3-4.3" })),
  ChevronDown: I(["m6 9 6 6 6-6"]),
  ChevronRight: I(["m9 6 6 6-6 6"]),
  ArrowRight: I(["M5 12h14", "m13 6 6 6-6 6"]),
  Terminal: I(["m4 17 6-6-6-6", "M12 19h8"]),
  Shield: I(["M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"]),
  GitBranch: ({ size = 18, ...r }) => React.createElement("svg", { viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round", ...r }, React.createElement("line", { x1: 6, y1: 3, x2: 6, y2: 15 }), Circle(18, 6, 3), Circle(6, 18, 3), React.createElement("path", { d: "M18 9a9 9 0 0 1-9 9" })),
  Cpu: ({ size = 18, ...r }) => React.createElement("svg", { viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round", ...r }, React.createElement("rect", { x: 6, y: 6, width: 12, height: 12, rx: 2 }), React.createElement("path", { d: "M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2" })),
  Database: ({ size = 18, ...r }) => React.createElement("svg", { viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round", ...r }, React.createElement("ellipse", { cx: 12, cy: 5, rx: 8, ry: 3 }), React.createElement("path", { d: "M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" })),
  Network: ({ size = 18, ...r }) => React.createElement("svg", { viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round", ...r }, React.createElement("rect", { x: 9, y: 2, width: 6, height: 6, rx: 1 }), React.createElement("rect", { x: 3, y: 16, width: 6, height: 6, rx: 1 }), React.createElement("rect", { x: 15, y: 16, width: 6, height: 6, rx: 1 }), React.createElement("path", { d: "M12 8v4M12 12H6v4M12 12h6v4" })),
  Lock: ({ size = 18, ...r }) => React.createElement("svg", { viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round", ...r }, React.createElement("rect", { x: 4, y: 11, width: 16, height: 10, rx: 2 }), React.createElement("path", { d: "M8 11V7a4 4 0 0 1 8 0v4" })),
  Key: ({ size = 18, ...r }) => React.createElement("svg", { viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round", ...r }, Circle(7.5, 15.5, 4.5), React.createElement("path", { d: "M10.7 12.3 19 4M16 7l3 3M14 9l2 2" })),
  Globe: ({ size = 18, ...r }) => React.createElement("svg", { viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round", ...r }, Circle(12, 12, 9), React.createElement("path", { d: "M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18" })),
  Leaf: I(["M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10z", "M2 21c0-3 1.85-5.36 5.08-6"]),
  Layers: I(["m12 2 9 5-9 5-9-5 9-5z", "m3 12 9 5 9-5", "m3 17 9 5 9-5"]),
  Check: I(["M20 6 9 17l-5-5"]),
  Copy: ({ size = 18, ...r }) => React.createElement("svg", { viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round", ...r }, React.createElement("rect", { x: 9, y: 9, width: 12, height: 12, rx: 2 }), React.createElement("path", { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" })),
  Trash: I(["M3 6h18", "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"]),
  Logout: I(["M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4", "m16 17 5-5-5-5", "M21 12H9"]),
  Settings: ({ size = 18, ...r }) => React.createElement("svg", { viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round", ...r }, Circle(12, 12, 3), React.createElement("path", { d: "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" })),
  Mail: ({ size = 18, ...r }) => React.createElement("svg", { viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round", ...r }, React.createElement("rect", { x: 2, y: 4, width: 20, height: 16, rx: 2 }), React.createElement("path", { d: "m2 7 10 6 10-6" })),
  Clock: ({ size = 18, ...r }) => React.createElement("svg", { viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round", ...r }, Circle(12, 12, 9), React.createElement("path", { d: "M12 7v5l3 2" })),
  Dollar: I(["M12 2v20", "M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"]),
};

window.VxIcons = Icons;

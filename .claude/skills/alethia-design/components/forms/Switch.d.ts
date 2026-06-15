import * as React from "react";

declare namespace JSX { interface Element {} }

export interface SwitchProps extends React.InputHTMLAttributes<HTMLInputElement> {}

/** On/off toggle for settings (autoscaling, HA, self-healing). */
export function Switch(props: SwitchProps): JSX.Element;

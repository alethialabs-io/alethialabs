import * as React from "react";

declare namespace JSX { interface Element {} }

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Monospace input for codes, tokens, CIDRs, IDs. */
  mono?: boolean;
}
export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

/**
 * Single-line text input.
 * @startingPoint section="Forms" subtitle="Text inputs, labels, hints" viewport="700x150"
 */
export function Input(props: InputProps): JSX.Element;
/** Multi-line text input. */
export function Textarea(props: TextareaProps): JSX.Element;

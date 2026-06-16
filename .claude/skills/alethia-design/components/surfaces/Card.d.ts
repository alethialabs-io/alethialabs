import * as React from "react";

declare namespace JSX { interface Element {} }

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Adds hover border/background for clickable cards. */
  interactive?: boolean;
  /** Removes the resting shadow (use inside dense panels). */
  flat?: boolean;
  children?: React.ReactNode;
}

/**
 * Bordered surface container with optional Header/Title/Description/Body/Footer parts.
 * @startingPoint section="Surfaces" subtitle="Card container + header / body / footer" viewport="700x150"
 */
export function Card(props: CardProps): JSX.Element;
export function CardHeader(props: React.HTMLAttributes<HTMLDivElement>): JSX.Element;
export function CardTitle(props: React.HTMLAttributes<HTMLDivElement>): JSX.Element;
export function CardDescription(props: React.HTMLAttributes<HTMLDivElement>): JSX.Element;
export function CardBody(props: React.HTMLAttributes<HTMLDivElement>): JSX.Element;
export function CardFooter(props: React.HTMLAttributes<HTMLDivElement>): JSX.Element;

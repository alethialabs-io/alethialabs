"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";
import { CheckIcon, ChevronsUpDown } from "lucide-react";
import * as RPNInput from "react-phone-number-input";
import flags from "react-phone-number-input/flags";

import { cn } from "./utils";
import { Button } from "./button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "./command";
import { Input } from "./input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "./popover";

type PhoneInputProps = Omit<
	React.ComponentProps<"input">,
	"onChange" | "value" | "ref"
> &
	Omit<RPNInput.Props<typeof RPNInput.default>, "onChange"> & {
		/** Emits the E.164 value (empty string when cleared). */
		onChange?: (value: RPNInput.Value) => void;
	};

/**
 * International phone input: a country flag dropdown (dial code) joined to a
 * formatted national number field. Built on react-phone-number-input but styled
 * with our squared/grayscale UI kit. Controlled — `value` is an E.164 string and
 * `onChange` emits E.164 (empty string when cleared) so it drops straight into a
 * react-hook-form Controller.
 */
const PhoneInput: React.ForwardRefExoticComponent<PhoneInputProps> =
	React.forwardRef<React.ElementRef<typeof RPNInput.default>, PhoneInputProps>(
		({ className, onChange, ...props }, ref) => (
			<RPNInput.default
				ref={ref}
				className={cn("flex", className)}
				flagComponent={FlagComponent}
				countrySelectComponent={CountrySelect}
				inputComponent={InputComponent}
				smartCaret={false}
				// react-phone-number-input emits `undefined` for an empty/partial value;
				// normalize to "" so the RHF field stays a controlled string.
				onChange={(value) => onChange?.(value || ("" as RPNInput.Value))}
				{...props}
			/>
		),
	);
PhoneInput.displayName = "PhoneInput";

/** The number field — our Input, with the left edge joined to the country button. */
const InputComponent = React.forwardRef<
	HTMLInputElement,
	React.ComponentProps<"input">
>(({ className, ...props }, ref) => (
	<Input className={cn("border-l-0", className)} {...props} ref={ref} />
));
InputComponent.displayName = "InputComponent";

interface CountryEntry {
	label: string;
	value: RPNInput.Country | undefined;
}

interface CountrySelectProps {
	disabled?: boolean;
	value: RPNInput.Country;
	options: CountryEntry[];
	onChange: (country: RPNInput.Country) => void;
}

/** The dial-code country picker — Popover + searchable Command of flags. */
function CountrySelect({
	disabled,
	value: selectedCountry,
	options: countryList,
	onChange,
}: CountrySelectProps) {
	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button
					type="button"
					variant="outline"
					size="default"
					className="flex h-9 gap-1 rounded-none border-r-0 px-3 focus:z-10"
					disabled={disabled}
				>
					<FlagComponent
						country={selectedCountry}
						countryName={selectedCountry}
					/>
					<ChevronsUpDown
						className={cn(
							"-mr-2 size-4 opacity-50",
							disabled ? "hidden" : "opacity-100",
						)}
					/>
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-[300px] p-0">
				<Command>
					<CommandInput placeholder="Search country…" />
					<CommandList>
						<CommandEmpty>No country found.</CommandEmpty>
						<CommandGroup>
							{countryList
								.filter((x): x is { label: string; value: RPNInput.Country } =>
									Boolean(x.value),
								)
								.map((option) => (
									<CommandItem
										key={option.value}
										className="gap-2"
										onSelect={() => onChange(option.value)}
									>
										<FlagComponent
											country={option.value}
											countryName={option.label}
										/>
										<span className="flex-1 text-sm">{option.label}</span>
										<span className="text-sm text-muted-foreground">
											{`+${RPNInput.getCountryCallingCode(option.value)}`}
										</span>
										<CheckIcon
											className={cn(
												"ml-auto size-4",
												option.value === selectedCountry
													? "opacity-100"
													: "opacity-0",
											)}
										/>
									</CommandItem>
								))}
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}

/** A single country flag, sized to sit inline with text. */
function FlagComponent({ country, countryName }: RPNInput.FlagProps) {
	const Flag = flags[country];
	return (
		<span className="flex h-4 w-6 overflow-hidden rounded-sm bg-foreground/10 [&_svg]:size-full">
			{Flag && <Flag title={countryName} />}
		</span>
	);
}

export { PhoneInput };

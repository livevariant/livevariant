import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  LabelHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes
} from "react";
import { useState } from "react";

/**
 * The package's own primitives, deliberately tiny: a host app should be
 * able to drop these components into ANY React tree, so they cannot
 * lean on a design system the host may not run. Plain elements, lv-
 * classes, themeable via --lv-* variables in styles.css.
 */

function cx(...parts: (string | false | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export function Button({
  variant,
  size,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "outline" | "ghost";
  size?: "sm" | "lg";
}) {
  return (
    <button
      type="button"
      {...rest}
      className={cx(
        "lv-btn",
        variant && `lv-btn--${variant}`,
        size && `lv-btn--${size}`,
        className
      )}
    />
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx("lv-input", props.className)} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cx("lv-select", props.className)} />;
}

export function Label(props: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label {...props} className={cx("lv-label", props.className)} />;
}

export function Field({
  label,
  htmlFor,
  hint,
  children
}: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="lv-field">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="lv-hint">{hint}</p>}
    </div>
  );
}

export function Card({
  title,
  description,
  children
}: {
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="lv-card">
      {title && <h2 className="lv-card-title">{title}</h2>}
      {description && <p className="lv-card-description">{description}</p>}
      {children}
    </section>
  );
}

/** A copyable block of code or a bare value, with an explaining intro. */
export function Snippet({
  intro,
  code,
  label
}: {
  intro?: ReactNode;
  code: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="lv-snippet">
      <div className="lv-row">
        <p className="lv-hint lv-grow">{intro ?? label}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            navigator.clipboard
              .writeText(code)
              .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
              .catch(() => {
                // Denied clipboard must not show a false "Copied".
              });
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

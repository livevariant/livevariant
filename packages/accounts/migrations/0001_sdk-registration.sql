CREATE TABLE `publishable_keys` (
	`key` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`label` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `publishable_keys_org_idx` ON `publishable_keys` (`org_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tests` (
	`test_id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`kh` text,
	`name` text,
	`encoded` text,
	`region` text,
	`added_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`kh`) REFERENCES `keys`(`kh`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_tests`("test_id", "org_id", "kh", "name", "encoded", "region", "added_at") SELECT "test_id", "org_id", "kh", "name", "encoded", "region", "added_at" FROM `tests`;--> statement-breakpoint
DROP TABLE `tests`;--> statement-breakpoint
ALTER TABLE `__new_tests` RENAME TO `tests`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `tests_org_added_idx` ON `tests` (`org_id`,`added_at`,`test_id`);--> statement-breakpoint
CREATE INDEX `tests_kh_idx` ON `tests` (`kh`);
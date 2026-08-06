CREATE TABLE `asset_refs` (
	`asset_id` text NOT NULL,
	`test_id` text NOT NULL,
	`org_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`asset_id`, `test_id`),
	FOREIGN KEY (`test_id`) REFERENCES `tests`(`test_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `asset_refs_org` ON `asset_refs` (`org_id`);--> statement-breakpoint
CREATE INDEX `asset_refs_asset` ON `asset_refs` (`asset_id`);
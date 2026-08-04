-- AlterTable
ALTER TABLE `contract_templates` ADD COLUMN `elementsSchema` JSON NULL,
    ADD COLUMN `source_file` VARCHAR(256) NULL,
    ADD COLUMN `style` JSON NULL;

import type { Catalog } from 'langsys-js-server';

declare global {
    namespace App {
        interface Locals {
            langsysCatalog: Catalog;
            langsysLocale: string;
        }
    }
}

export {};

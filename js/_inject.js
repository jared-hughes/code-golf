// Exports are no longer imported into each file by default,
// to make Typescript happy.
// Remember to import createElement if you need JSX

// Small util functions.
export const $     = document.querySelector.bind(document);
export const $$    = document.querySelectorAll.bind(document);
export const comma = i => i.toLocaleString('en');

// Our default JSX factory.
export function createElement(tag, attrs, ...children) {
    const element = document.createElement(tag);

    // Set all defined/non-null attributes.
    Object.entries(attrs ?? {})
        .filter(([     , value]) => value != null)
        .forEach(([name, value]) => element.setAttribute(name, value));

    // Set all defined/non-null children.
    element.append(...children.flat().filter(e => e != null));

    return element;
}

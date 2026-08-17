export function selectedModel(selection, catalog) {
    const option = catalog.options.find((candidate) => candidate.id === selection.model);
    if (!option)
        throw new Error(`model "${selection.model}" is not available`);
    if (selection.effort && !option.efforts?.includes(selection.effort)) {
        throw new Error(`effort "${selection.effort}" is not supported by model "${selection.model}"`);
    }
    if (selection.serviceTier !== undefined &&
        selection.serviceTier !== null &&
        !option.serviceTiers?.some((tier) => tier.id === selection.serviceTier)) {
        throw new Error(`service tier "${selection.serviceTier}" is not supported by model "${selection.model}"`);
    }
    return option;
}
export function modelSupportsTools(option) {
    return option.toolUse !== false;
}

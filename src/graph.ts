/**
 * graph.ts
 * Define the factory graph and its components
 * lgfrbcsgo & Nikolaus - October 2020
 */
import {
    ContainerElement,
    CONTAINERS_ASCENDING_BY_CAPACITY,
    Craftable,
    isOre,
    Item,
    Quantity,
} from "./items"
import { findRecipe, Recipe } from "./recipes"

/** Maximum number of incoming/outgoing container links */
export const MAX_CONTAINER_LINKS = 10

/** Maximum number of incoming industry links */
export const MAX_INDUSTRY_LINKS = 7

export type PerMinute = number

/**
 * Container holding components. A set of producers is filling
 * this container, and a set of consumers is drawing from this container.
 */
export class ContainerNode {
    readonly producers = new Set<IndustryNode | TransferNode>()
    readonly consumers = new Set<IndustryNode | TransferNode>()

    /**
     * Initialize a new ContainerNode
     * @param name Node name
     * @param item Item stored in this container
     * @param factory The factory this container belongs to
     * @param split If not 1.0, the fraction of some consumer's input supplied
     * by this container. In some cases the
     * number of input links exceeds the limit, so we needed to split
     * the container in two (or more). To prevent an upstream backup,
     * split containers can only link to one industry.
     */
    constructor(
        readonly name: string,
        readonly item: Item,
        readonly factory: FactoryGraph,
        readonly split: number,
    ) {}

    /**
     * Return the number of producers filling this container
     */
    get incomingLinkCount(): number {
        return this.producers.size
    }

    /**
     * Return the number of consumers drawing from this container
     */
    get outgoingLinkCount(): number {
        return this.consumers.size
    }

    /**
     * Return the rate at which the producers are filling this container.
     */
    get ingress(): PerMinute {
        // Assume infinite ore availablility
        if (isOre(this.item)) {
            return Infinity
        }
        return Array.from(this.producers)
            .map((producer) => {
                if (isIndustryNode(producer)) {
                    return producer.getOutput(this.item)
                } else if (producer.item === this.item) {
                    return producer.outflowRate
                } else {
                    return 0
                }
            })
            .reduce((totalIngress, ingress) => totalIngress + ingress, 0)
    }

    /**
     * Return the rate at which the consumers are drawing from this container.
     */
    get egress(): PerMinute {
        return Array.from(this.consumers)
            .map((consumer) => {
                if (isIndustryNode(consumer)) {
                    return this.split * consumer.getInput(this.item)
                } else if (consumer.item === this.item) {
                    return consumer.inflowRatePerContainer
                } else {
                    return 0
                }
            })
            .reduce((totalEgress, egress) => totalEgress + egress, 0)
    }

    /**
     * Return the required maintain value to store the required components for all consumers
     */
    get maintain(): Quantity {
        let maintain = 0
        for (const consumer of this.consumers) {
            /* Skip transfer units */
            if (isTransferNode(consumer)) {
                continue
            }
            for (const ingredient of findRecipe(consumer.item).ingredients) {
                if (ingredient.item === this.item) {
                    maintain += ingredient.quantity
                }
            }
        }
        return maintain * this.split
    }

    /**
     * Return the required container (size) to hold the maintain value
     */
    get container(): ContainerElement {
        if (CONTAINERS_ASCENDING_BY_CAPACITY.length < 1) {
            throw new Error("CONTAINERS_ASCENDING_BY_CAPACITY is empty")
        }
        const requiredCapacity = this.maintain * this.item.volume
        let requiredContainer: ContainerElement = CONTAINERS_ASCENDING_BY_CAPACITY[0]
        for (const checkContainer of CONTAINERS_ASCENDING_BY_CAPACITY) {
            if (requiredCapacity <= checkContainer.capacity) {
                requiredContainer = checkContainer
            }
        }
        return requiredContainer
    }

    /**
     * Return if this is a split container
     */
    get isSplit(): boolean {
        return this.split !== 1.0
    }

    /**
     * Check if a container can support additional incoming links
     * @param count Number of new incoming links
     */
    canAddIncomingLinks(count: number) {
        return this.incomingLinkCount + count <= MAX_CONTAINER_LINKS
    }

    /**
     * Check if a container can support additional outgoing links
     * @param count Number of new outgoing links
     */
    canAddOutgoingLinks(count: number) {
        /* Check if this is a split input container */
        if (this.isSplit) {
            return false
        }
        /* Ore containers have no byproducts */
        if (isOre(this.item)) {
            return this.outgoingLinkCount + count <= MAX_CONTAINER_LINKS
        }
        /* Get byproducts stored in this container */
        const recipe = findRecipe(this.item)
        let reservedByproductLinks = recipe.byproducts.length
        for (const byproduct of recipe.byproducts) {
            /* Check if this container already has a consumer for this byproduct */
            for (const consumer of this.consumers) {
                if (consumer.item === byproduct.item) {
                    reservedByproductLinks += -1
                }
            }
        }
        return this.outgoingLinkCount + count + reservedByproductLinks <= MAX_CONTAINER_LINKS
    }
}

/**
 * Container holding components to handle industry link limits (when industries require
 * more than 7 ingredients, for example). A set of TransferNodes is filling
 * this container, and a set of IndustryNodes is drawing from this container.
 */
export class TransferContainerNode {
    readonly producers = new Set<TransferNode>()
    readonly consumers = new Set<IndustryNode>()

    /**
     * Initialize a new TransferContainerNode
     * @param items Items stored in this container
     * @param factory The factory this container belongs to
     */
    constructor(readonly name: string, readonly items: Item[], readonly factory: FactoryGraph) {}

    /**
     * Return the number of producers filling this container
     */
    get incomingLinkCount(): number {
        return this.producers.size
    }

    /**
     * Return the number of consumers drawing from this container
     */
    get outgoingLinkCount(): number {
        return this.consumers.size
    }

    /**
     * Return the required maintain value to store the required components for all consumers
     */
    get maintain(): Map<Item, Quantity> {
        const maintain: Map<Item, Quantity> = new Map()
        for (const item of this.items) {
            for (const consumer of this.consumers) {
                for (const ingredient of findRecipe(consumer.item).ingredients) {
                    if (ingredient.item === item) {
                        if (maintain.has(item)) {
                            maintain.set(item, maintain.get(item)! + ingredient.quantity)
                        } else {
                            maintain.set(item, ingredient.quantity)
                        }
                    }
                }
            }
        }
        return maintain
    }

    /**
     * Return the required container (size) to hold the maintain values
     */
    get container(): ContainerElement {
        if (CONTAINERS_ASCENDING_BY_CAPACITY.length < 1) {
            throw new Error("CONTAINERS_ASCENDING_BY_CAPACITY is empty")
        }
        let requiredCapacity = 0
        const maintain = this.maintain
        for (const [item, quantity] of maintain.entries()) {
            requiredCapacity += quantity * item.volume
        }
        let requiredContainer: ContainerElement = CONTAINERS_ASCENDING_BY_CAPACITY[0]
        for (const checkContainer of CONTAINERS_ASCENDING_BY_CAPACITY) {
            if (requiredCapacity <= checkContainer.capacity) {
                requiredContainer = checkContainer
            }
        }
        return requiredContainer
    }

    /**
     * Check if a container can support additional incoming links
     * @param count Number of new incoming links
     */
    canAddIncomingLinks(count: number) {
        return this.incomingLinkCount + count <= MAX_CONTAINER_LINKS
    }

    /**
     * Check if a container can support additional outgoing links
     * @param count Number of new outgoing links
     */
    canAddOutgoingLinks(count: number) {
        return this.outgoingLinkCount + count <= MAX_CONTAINER_LINKS
    }
}

/**
 * TransferContainerNode type guard
 * @param node Node to check
 */
export function isTransferContainerNode(
    node: ContainerNode | TransferContainerNode,
): node is TransferContainerNode {
    return node instanceof TransferContainerNode
}

/**
 * Factory output node
 */
export class OutputNode extends ContainerNode {
    /**
     * Initialize a new OutputNode
     * @param name Node name
     * @param item Item stored in this container
     * @param outputRate Required production rate
     * @param maintainedOutput The number of items to maintain
     * @param factory The factory this output belongs to
     */
    constructor(
        name: string,
        item: Craftable,
        readonly outputRate: PerMinute,
        readonly maintainedOutput: Quantity,
        factory: FactoryGraph,
    ) {
        super(name, item, factory, 1.0)
    }

    get egress(): PerMinute {
        return super.egress + this.outputRate
    }

    get maintain(): Quantity {
        return super.maintain + this.maintainedOutput
    }
}

/**
 * Industry producing components. Draws inputs from a set of containers, and outputs
 * to a single container.
 */
export class IndustryNode {
    readonly inputs: Set<ContainerNode | TransferContainerNode> = new Set()
    readonly recipe: Recipe

    output: ContainerNode | undefined

    get industry() {
        return this.recipe.industry
    }

    get item(): Craftable {
        // TODO: remove cast then gases are craftable
        return this.recipe.product.item as Craftable
    }

    /**
     * Return the number of inputs to this industry
     */
    get incomingLinkCount(): number {
        return this.inputs.size
    }

    constructor(readonly name: string, item: Craftable, readonly factory: FactoryGraph) {
        this.recipe = findRecipe(item)
    }

    /**
     * Add input container for an item
     * @param container Input container
     */
    takeFrom(container: ContainerNode | TransferContainerNode) {
        this.inputs.add(container)
        container.consumers.add(this)
    }

    /**
     * Add or replace output container
     * @param container Output container
     */
    outputTo(container: ContainerNode) {
        if (this.output) {
            this.output.producers.delete(this)
        }
        this.output = container
        container.producers.add(this)
    }

    /**
     * Return the production rate of a given item
     * @param item Item for which the production rate is calculated
     */
    getOutput(item: Item): PerMinute {
        let quantity = 0
        const recipe = findRecipe(this.item)
        for (const produced of [...recipe.byproducts, recipe.product]) {
            if (item === produced.item) {
                quantity += produced.quantity
            }
        }
        return quantity / recipe.time
    }

    /**
     * Return the consumption rate of a given item
     * @param item Item for which the consumption rate is calculated
     */
    getInput(item: Item): PerMinute {
        let quantity = 0
        const recipe = findRecipe(this.item)
        for (const ingredient of recipe.ingredients) {
            if (ingredient.item === item) {
                quantity += ingredient.quantity
            }
        }
        return quantity / recipe.time
    }

    /**
     * Check if a industry can support additional incoming links
     * @param count Number of new incoming links
     */
    canAddIncomingLinks(count: number) {
        return this.incomingLinkCount + count <= MAX_INDUSTRY_LINKS
    }
}

/**
 * IndustryNode type guard
 * @param node Node to check
 */
export function isIndustryNode(node: IndustryNode | TransferNode): node is IndustryNode {
    return node instanceof IndustryNode
}

export class TransferNode {
    /**
     * Transfer Unit moving components. Draws inputs from a set of containers, and outputs
     * to a single container.
     */
    readonly inputs = new Set<ContainerNode>()
    readonly transferRate = Infinity // TODO: transfer rate is not infinite
    output: ContainerNode | TransferContainerNode | undefined

    /**
     * Return the number of inputs to this transfer unit
     */
    get incomingLinkCount(): number {
        return this.inputs.size
    }

    /**
     * Return the transfer rate into the output container
     * This must be the minimum of
     * (total consumption rate leaving output, maximum transfer unit rate)
     */
    get outflowRate(): PerMinute {
        let consumptionRate = 0
        if (this.output !== undefined) {
            for (const consumer of this.output.consumers) {
                if (consumer instanceof IndustryNode) {
                    consumptionRate += consumer.getInput(this.item)
                } else {
                    consumptionRate += consumer.inflowRatePerContainer
                }
            }
        }
        return Math.min(consumptionRate, this.transferRate)
    }

    /**
     * Return the transfer inflow rate per container, assuming the transfer unit
     * draws equally from all inputs
     */
    get inflowRatePerContainer(): PerMinute {
        return this.outflowRate / this.inputs.size
    }

    /**
     * Initialize a new TransferNode
     * @param item Item produced by this industry
     * @param factory The factory which this transfer unit belongs to
     */
    constructor(readonly name: string, readonly item: Item, readonly factory: FactoryGraph) {}

    /**
     * Add an input container for an item
     * @param container Input container
     */
    takeFrom(container: ContainerNode) {
        this.inputs.add(container)
        container.consumers.add(this)
    }

    /**
     * Add or replace output container
     * @param container Output container
     */
    outputTo(container: ContainerNode | TransferContainerNode) {
        if (this.output) {
            this.output.producers.delete(this)
        }
        this.output = container
        container.producers.add(this)
    }

    /**
     * Check if a transfer unit can support additional incoming links
     * @param count Number of new incoming links
     */
    canAddIncomingLinks(count: number) {
        return this.incomingLinkCount + count <= MAX_INDUSTRY_LINKS
    }
}

/**
 * TransferNode type guard
 * @param node Node to check
 */
export function isTransferNode(node: IndustryNode | TransferNode): node is TransferNode {
    return node instanceof TransferNode
}

/**
 * Graph containing factory components (industries and containers).
 */
export class FactoryGraph {
    containers = new Set<ContainerNode>()
    industries = new Set<IndustryNode>()
    transferUnits = new Set<TransferNode>()
    transferContainers = new Set<TransferContainerNode>()
    temporaryContainers = new Set<ContainerNode>()

    /**
     * Return the set of all products produced or stored in this factory
     */
    get products(): Set<Item> {
        return new Set(Array.from(this.containers).map((node) => node.item))
    }

    /**
     * Add an industry to the factory graph
     * @see {@link IndustryNode}
     */
    createIndustry(item: Craftable): IndustryNode {
        const industries = this.getIndustries(item)
        const name = item.name + " P" + industries.size
        const industry = new IndustryNode(name, item, this)
        this.industries.add(industry)
        return industry
    }

    /**
     * Add a transfer unit to the factory graph
     * @see {@link TransferNode}
     */
    createTransferUnit(item: Item) {
        const transfers = this.getTransferUnits(item)
        const name = item.name + " T" + transfers.size
        const transfer = new TransferNode(name, item, this)
        this.transferUnits.add(transfer)
        return transfer
    }

    /**
     * Add a temporary container to the factory graph
     * @see {@link ContainerNode}
     */
    createTemporaryContainer(item: Item): ContainerNode {
        const name = ""
        const container = new ContainerNode(name, item, this, 1.0)
        this.temporaryContainers.add(container)
        return container
    }

    /**
     * Add a container to the factory graph
     * @see {@link ContainerNode}
     */
    createContainer(item: Item): ContainerNode {
        const containers = this.getContainers(item)
        const name = item.name + " C" + containers.size
        const container = new ContainerNode(name, item, this, 1.0)
        this.containers.add(container)
        return container
    }

    /**
     * Add a split container to the factory graph
     * @see {@link ContainerNode}
     */
    createSplitContainer(item: Item, split: number): ContainerNode {
        const containers = this.getContainers(item)
        const name = item.name + " C" + containers.size
        const container = new ContainerNode(name, item, this, split)
        this.containers.add(container)
        return container
    }

    /**
     * Add a transfer container to the factory graph
     * @see {@link TransferContainerNode}
     */
    createTransferContainer(items: Item[]): TransferContainerNode {
        const name = "Transfer Container " + this.transferContainers.size
        const container = new TransferContainerNode(name, items, this)
        this.transferContainers.add(container)
        return container
    }

    /**
     * Add an output node to the factory graph
     * @see {@link OutputNode}
     */
    createOutput(item: Craftable, outputRate: PerMinute, maintainedOutput: Quantity): OutputNode {
        const containers = this.getContainers(item)
        const name = item.name + " C" + containers.size
        const output = new OutputNode(name, item, outputRate, maintainedOutput, this)
        this.containers.add(output)
        return output
    }

    /**
     * Return the set of all industries producing a given item
     * @param item Item for which to find the industries
     */
    getIndustries(item: Item): Set<IndustryNode> {
        return new Set(Array.from(this.industries).filter((node) => node.item === item))
    }

    /**
     * Return the set of all consumers of a given item
     * @param item Item for which to find the consumers
     */
    getConsumers(item: Item): Set<IndustryNode> {
        return new Set(
            Array.from(this.industries).filter((node) =>
                findRecipe(node.item).ingredients.some((ingredient) => ingredient.item === item),
            ),
        )
    }

    /**
     * Return the set of all transfer units of a given item
     * @param item Item for which to find the consumers
     */
    getTransferUnits(item: Item): Set<TransferNode> {
        return new Set(Array.from(this.transferUnits).filter((node) => node.item === item))
    }

    /**
     * Return the set of all containers holding a given item
     * @param item Item for which to find the containers
     */
    getContainers(item: Item): Set<ContainerNode> {
        return new Set(Array.from(this.containers).filter((node) => node.item === item))
    }

    /**
     * Return the set of all transfer containers holding one or more of the
     * given items and no other items
     * @param items Items for which to find the TransferContainers
     */
    getTransferContainers(items: Set<Item>): Set<TransferContainerNode> {
        let transferContainers = Array.from(this.transferContainers)
        // Filter only those containing one or more of items
        transferContainers = transferContainers.filter((node) =>
            node.items.some((item) => Array.from(items).includes(item)),
        )
        // Filter out those containing anything not in items
        transferContainers = transferContainers.filter((node) =>
            Array.from(items).some((item) => !node.items.includes(item)),
        )
        return new Set(transferContainers)
    }
}
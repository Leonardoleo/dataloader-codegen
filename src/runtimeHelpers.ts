/**
 * @file These functions get referenced in the codegen'd output. Also may be
 * imported by human-defined dataloaders.
 */

import _ from 'lodash';
import AggregateError from 'aggregate-error';
import invariant from 'assert';
import objectHash from 'object-hash';
import { ApolloError } from 'apollo-server-express';

export function errorPrefix(resourcePath: ReadonlyArray<string>): string {
    return `[dataloader-codegen :: ${resourcePath.join('.')}]`;
}

/**
 * An error reflects missing item in response. It extends from the basic generic ApolloError.
 * It is not tie to apollo-server-express, but extending from ApolloError make it easier to debug your Apollo Server integration.
 * @see https://github.com/apollographql/apollo-server/blob/faba52c689c22472a19fcb65d78925df549077f7/packages/apollo-server-errors/src/index.ts#L3
 */
export class BatchItemNotFoundError extends ApolloError {
    constructor(message: string) {
        super(message, 'BATCH_ITEM_NOT_FOUND_ERROR');
        Error.captureStackTrace(this, this.constructor);
        Object.defineProperty(this, 'name', { value: 'BatchItemNotFoundError' });
    }
}

/**
 * An error reflects error when calling resource. It extends from the basic generic ApolloError.
 * It is not tie to apollo-server-express, but extending from ApolloError make it easier to debug your Apollo Server integration.
 * @see https://github.com/apollographql/apollo-server/blob/faba52c689c22472a19fcb65d78925df549077f7/packages/apollo-server-errors/src/index.ts#L3
 */
export class CaughtResourceError extends ApolloError {
    constructor(message: string, cause: Error, reorderResultsByValue: string | number | null) {
        super(message, 'CAUGHT_RESOURCE_ERROR', { cause, reorderResultsByValue });
        Error.captureStackTrace(this, this.constructor);
        Object.defineProperty(this, 'name', { value: 'CaughtResourceError' });
    }
}

/**
 * DataLoader options that use object-hash to calculate a cache key. This allows
 * the use of objects, arrays, etc. as keys. We use it in "passthrough" mode so
 * that it stringifies objects but doesn't waste time hashing them.
 */
export const cacheKeyOptions = {
    cacheKeyFn: (key: any) => objectHash(key, { algorithm: 'passthrough' }),
};

/**
 * Take in all objects passed to .load(), and bucket them by the non
 * batchKey attributes.
 *
 * We use this to chunk up the requests to the resource.
 *
 * Example:
 * ```js
 * partitionItems([
 *   { bar_id: 2, include_extra_info: true },
 *   { bar_id: 3, include_extra_info: false },
 *   { bar_id: 4, include_extra_info: true },
 * ], 'bar_id')
 * ```
 *
 * Returns:
 * `[ [ 0, 2 ], [ 1 ] ]`
 *
 * TODO: add generic instead of 'object' for the items array argument
 */
export function partitionItems(ignoreKey: string, items: ReadonlyArray<object>): ReadonlyArray<ReadonlyArray<number>> {
    const groups: {
        [key: string]: Array<number>;
    } = {};

    items.forEach((item, i) => {
        const hash = objectHash(_.omit(item, ignoreKey), { algorithm: 'passthrough' });
        groups[hash] = groups[hash] || [];
        groups[hash].push(i);
    });

    return Object.values(groups);
}

/**
 * Utility function to sort array of objects by a list of corresponding IDs
 *
 * Example:
 * ```js
 * sortByKeys({
 *   items: [ { id: 2, name: 'mark' }, { id: 1, name: 'ryan' } ],
 *   keys: [1, 2],
 *   prop: 'id',
 *   resourcePath: ['UserService', 'getUsers'],
 * })
 * ```
 *
 * Returns:
 * ```js
 * [ { id: 1, name: 'ryan' }, { id: 2, name: 'mark' } ]
 * ```
 *
 * Items could be null, or contain unknown errors. If this is the case, we don't
 * know where in the results array the error should go, since there'll be no id
 * field to key off of. In this case, we have to throw an error and throw away
 * all results :/
 *
 * TODO: Extend this to support endpionts that use multiple keys for sorting
 */
export function sortByKeys<V>({
    /** List of objects returned by a batch endpoint */
    items,
    /** The IDs we originally requested from the endpoint */
    keys,
    /** The attribute of each element in `items` that maps it to an element in `keys`. */
    prop,
    /** Some path that indicates what resource this is being used on. Used for stack traces. */
    resourcePath,
}: {
    items: ReadonlyArray<V>;
    keys: ReadonlyArray<string | number>;
    prop: string;
    resourcePath: ReadonlyArray<string>;
}): ReadonlyArray<V | BatchItemNotFoundError> {
    // Construct a Map of: Map<item key, item>
    const itemsMap: Map<string | number, V | BatchItemNotFoundError> = new Map();

    items.forEach((item: V) => {
        invariant(item != null, `${errorPrefix(resourcePath)} Cannot sort list of items containing an falsey element`);

        if (_.isError(item)) {
            /* istanbul ignore if: sanity check */
            if (!(item instanceof CaughtResourceError)) {
                throw new AggregateError([
                    new Error(
                        `${errorPrefix(resourcePath)} Cannot sort list of items containg an unknown error: ${
                            item.message
                        }`,
                    ),
                    item,
                ]);
            }

            const { reorderResultsByValue } = item;

            /* istanbul ignore if: sanity check */
            if (typeof reorderResultsByValue !== 'string' && typeof reorderResultsByValue !== 'number') {
                throw new Error(
                    [
                        `${errorPrefix(resourcePath)} Cannot sort list of items if CaughtResourceError`,
                        'does not contain a string or number value for reorderResultsByValue',
                    ].join(' '),
                );
            }

            itemsMap.set(String(reorderResultsByValue), item);
        } else {
            // @ts-ignore: TODO: Work how to tell typescript item[prop] exists
            invariant(item[prop] != null, `${errorPrefix(resourcePath)} Could not find property "${prop}" in item`);
            // @ts-ignore: TODO: Work how to tell typescript item[prop] exists
            itemsMap.set(String(item[prop]), item);
        }
    });

    // Loop through the keys and for each one retrieve proper item. For missing
    // items, generate an BatchItemNotFoundError. (This can be caught specifically in resolvers.)
    return keys.map(
        key =>
            itemsMap.get(String(key)) ||
            new BatchItemNotFoundError(
                `${errorPrefix(resourcePath)} Response did not contain item with ${prop} = ${String(key)}`,
            ),
    );
}

/**
 * Perform the inverse mapping from partitionItems on the nested results we get
 * back from the service.
 *
 * Example
 * ```js
 * unPartitionResults(
 *   [ [0, 2], [1] ],
 *   [ [ { foo: 'foo' }, { bar: 'bar' } ], [ {'baz': 'baz'} ] ],
 * )
 * ```
 *
 * Returns:
 * ```
 * [
 *   { foo: 'foo' },
 *   { baz: 'baz' },
 *   { bar: 'bar' },
 * ]
 */
export function unPartitionResults<T>(
    /** Should be a nested array of IDs, as generated by partitionItems */
    requestGroups: ReadonlyArray<ReadonlyArray<number>>,
    /** The results back from the service, in the same shape as groups */
    resultGroups: ReadonlyArray<ReadonlyArray<T | CaughtResourceError | BatchItemNotFoundError>>,
): ReadonlyArray<T | Error> {
    /**
     * e.g. with our inputs, produce:
     * ```js
     * [
     *   [
     *      { order: 0, result: { foo: 'foo' } },
     *      { order: 2, result: { bar: 'bar' } },
     *   ],
     *   [
     *      { order: 1, result: { baz: 'baz' } },
     *   ]
     * ]
     * ```
     */
    const zippedGroups = requestGroups.map((ids, i) => ids.map((id, j) => ({ order: id, result: resultGroups[i][j] })));

    /**
     * Flatten and sort the groups - e.g.:
     * ```js
     * [
     *   { order: 0, result: { foo: 'foo' } },
     *   { order: 1, result: { baz: 'baz' } },
     *   { order: 2, result: { bar: 'bar' } }
     * ]
     * ```
     */
    const sortedResults: ReadonlyArray<{ order: number; result: T | Error }> = _.sortBy(_.flatten(zippedGroups), [
        'order',
    ]);

    // Now that we have a sorted array, return the actual results!
    return sortedResults
        .map(r => r.result)
        .map(result => {
            if (result instanceof CaughtResourceError) {
                return result.cause;
            } else {
                return result;
            }
        });
}

/**
 * Turn a dictionary of results into an ordered list
 *
 * Example
 * ```js
 * resultsDictToList(
 *   {
 *     '3': { foo: '!' },
 *     '1': { foo: 'hello' },
 *     '2': { foo: 'world' },
 *   },
 *   [1, 2, 3],
 *   resourcePath: ['FooService', 'getFoos'],
 * )
 * ```
 *
 * Returns:
 * ```
 * [
 *   { foo: 'hello' },
 *   { foo: 'world' },
 *   { foo: '!' },
 * ]
 */
export function resultsDictToList<V>(
    /**
     * A dictionary of results. Object keys that were numbers will get turned into strings by JavaScript.
     * @see https://stackoverflow.com/a/3633390
     */
    response: { [key: string]: V },
    /** The IDs we originally requested from the endpoint */
    keys: ReadonlyArray<string | number>,
    /** Some path that indicates what resource this is being used on. Used for stack traces. */
    resourcePath: ReadonlyArray<string>,
): ReadonlyArray<V | Error> {
    return keys.map(
        key =>
            response[String(key)] ||
            new BatchItemNotFoundError(
                `${errorPrefix(resourcePath)} Could not find key = "${String(key)}" in the response dict.`,
            ),
    );
}

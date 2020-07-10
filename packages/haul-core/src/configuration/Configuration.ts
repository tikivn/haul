import merge from 'lodash.merge';
import { MinifyOptions } from 'terser';
import { DeepNonNullable } from 'utility-types';
import webpack from 'webpack';
import path from 'path';
import { cpus } from 'os';
import isCi from 'is-ci';
import {
  BundleFormat,
  SourceMap,
  LooseModeConfig,
  EnvOptions,
  WebpackConfigTransform,
} from '../types';
import { ExternalBundle } from './ExternalBundle';
import { OwnedBundle, OwnedBundleProperties } from './OwnedBundle';
import Runtime from '../runtime/Runtime';
import { ConfigurationLoader } from './ConfigurationLoader';
import { DEFAULT_PORT } from '../constants';

export type ServerConfig = {
  port?: number;
  host?: string;
};

export type FinalServerConfig = DeepNonNullable<ServerConfig>;

export type TemplatesConfig = {
  filename: { [platform: string]: string };
};

export type FeaturesConfig = {
  multiBundle?: 1 | 2;
};

export type FinalFeaturesConfig = DeepNonNullable<FeaturesConfig>;

export type BundleConfig =
  | {
      name?: string;
      entry: string | string[] | { entryFiles: string[]; setupFiles: string[] };
      type?: BundleFormat;
      platform?: string;
      root?: string;
      dev?: boolean;
      assetsDest?: string;
      minify?: boolean;
      minifyOptions?: Pick<
        MinifyOptions,
        Exclude<keyof MinifyOptions, 'sourceMap'>
      >;
      sourceMap?: SourceMap;
      looseMode?: LooseModeConfig;
      dll?: boolean;
      app?: boolean;
      dependsOn?: string[];
      providesModuleNodeModules?: Array<
        string | { name: string; directory: string }
      >;
      hasteOptions?: any;
      transform?: WebpackConfigTransform;
      maxWorkers?: number;
    }
  | ExternalBundleConfig;

export type ExternalBundleConfig = {
  name?: string;
  dll?: boolean;
  app?: boolean;
  dependsOn?: string[];
  copyBundle?: boolean;
  bundlePath: string;
  manifestPath?: string;
  assetsPath?: string;
};

// TODO: remove this type when moving base Webpack config to core
export type LegacyProjectConfig = {
  server: FinalServerConfig;
  bundles: {
    [bundleName: string]: {
      entry: { entryFiles: string[] };
      platform: string;
      root: string;
      assetsDest: string;
      dev: boolean;
      minify: boolean;
      providesModuleNodeModules: any;
      hasteOptions: any;
      maxWorkers: number;
      type: BundleFormat;
    };
  };
};

export type GetBaseWebpackConfig = (
  runtime: Runtime,
  envOptions: EnvOptions,
  bundleName: string,
  projectConfig: LegacyProjectConfig
) => webpack.Configuration;

export type BundleConfigBuilder = (
  env: EnvOptions,
  runtime: Runtime
) => BundleConfig;

export type ProjectConfig = {
  server?: ServerConfig;
  platforms?: string[];
  templates?: TemplatesConfig;
  features?: FeaturesConfig;
  bundles: { [bundleName: string]: BundleConfigBuilder | BundleConfig };
};

/**
 * A class representing a project configuration.
 */
export class Configuration {
  /**
   * Construct and return a `ConfigurationLoader` instance.
   *
   * @param runtime A `Runtime` instance.
   * @param root Absolute path to project root, usually a command working directory.
   * @param customPath A optional path to or filename of a Haul project config.
   */
  static getLoader(runtime: Runtime, root: string, customPath?: string) {
    return new ConfigurationLoader(runtime, root, customPath);
  }

  readonly platforms: string[];
  readonly server: FinalServerConfig;
  readonly templates: TemplatesConfig;
  readonly features: FinalFeaturesConfig;
  readonly bundleNames: string[];
  ownedBundles: OwnedBundle[] = [];
  externalBundles: ExternalBundle[] = [];

  /**
   * Constructs an instance of `Configuration` class.
   *
   * @param projectConfig A (unprocessed) project configuration object.
   * @param getBaseWebpackConfig A function to construct base Webpack config.
   * @param envOptions `EnvOptions` with settings from CLI.
   */
  constructor(
    private readonly projectConfig: ProjectConfig,
    public readonly getBaseWebpackConfig: GetBaseWebpackConfig,
    public readonly envOptions: EnvOptions
  ) {
    this.platforms = projectConfig.platforms || ['ios', 'android'];
    this.server = {
      host: projectConfig.server?.host || 'localhost',
      port: envOptions.port || projectConfig.server?.port || DEFAULT_PORT,
    };
    this.templates = merge(
      {
        filename: {
          ios: '[bundleName].jsbundle',
          android: '[bundleName].[platform].bundle',
          __server__: '[bundleName].[platform].bundle',
          __fallback__: '[bundleName].[platform].bundle',
        },
      },
      projectConfig.templates
    );
    this.features = merge(
      {
        multiBundle: 1,
      },
      projectConfig.features
    );
    this.bundleNames = Object.keys(projectConfig.bundles);
  }

  /**
   * Construct instances of `OwnedBundle` or `ExternalBundle` based on supplied
   * in constructor `projectConfig`.
   *
   * @param runtime A `Runtime` instance.
   *
   * @returns Unsorted array with `OwnedBundle | ExternalBundle` instances.
   */
  createBundles(runtime: Runtime): Array<OwnedBundle | ExternalBundle> {
    const bundles = this.bundleNames.map(bundleName => {
      const bundleConfigBuilder = this.projectConfig.bundles[bundleName];
      const bundleConfig =
        typeof bundleConfigBuilder === 'function'
          ? bundleConfigBuilder(this.envOptions, runtime)
          : bundleConfigBuilder;

      if ('bundlePath' in bundleConfig) {
        return new ExternalBundle(bundleConfig.name || bundleName, {
          type: bundleConfig.dll ? 'dll' : bundleConfig.app ? 'app' : 'default',
          bundlePath: bundleConfig.bundlePath,
          assetsPath: bundleConfig.assetsPath
            ? path.isAbsolute(bundleConfig.assetsPath)
              ? bundleConfig.assetsPath
              : path.join(
                  path.dirname(bundleConfig.bundlePath),
                  bundleConfig.assetsPath
                )
            : path.dirname(bundleConfig.bundlePath),
          manifestPath: bundleConfig.manifestPath,
          shouldCopy: Boolean(bundleConfig.copyBundle),
          dependsOn: bundleConfig.dependsOn || [],
        });
      }

      const inputModuleNames: string[] = [];
      const preloadModuleNames: string[] = [];
      if (typeof bundleConfig.entry === 'string') {
        inputModuleNames.push(bundleConfig.entry);
      } else if (Array.isArray(bundleConfig.entry)) {
        inputModuleNames.push(...bundleConfig.entry);
      } else {
        inputModuleNames.push(...bundleConfig.entry.entryFiles);
        preloadModuleNames.push(...bundleConfig.entry.setupFiles);
      }

      const name = bundleConfig.name || bundleName;
      const properties: OwnedBundleProperties = {
        mode: bundleConfig.dev || this.envOptions.dev ? 'dev' : 'prod',
        platform: bundleConfig.platform || this.envOptions.platform,
        bundlingMode: this.envOptions.bundleMode,
        outputType:
          this.envOptions.bundleTarget === 'server' ? 'server' : 'file',
        outputPath: this.envOptions.bundleOutput,
        format:
          this.envOptions.bundleTarget === 'server'
            ? 'basic-bundle'
            : bundleConfig.type || this.envOptions.bundleType || 'basic-bundle',
        type: bundleConfig.dll ? 'dll' : bundleConfig.app ? 'app' : 'default',
        context: bundleConfig.root || this.envOptions.root,
        inputModuleNames,
        preloadModuleNames,
        assetsDestination:
          bundleConfig.assetsDest || this.envOptions.assetsDest,
        minify: bundleConfig.minify || Boolean(this.envOptions.minify),
        minifyOptions: bundleConfig.minifyOptions || undefined,
        sourceMap:
          typeof bundleConfig.sourceMap !== 'undefined'
            ? bundleConfig.sourceMap
            : true,
        sourceMapDestination: this.envOptions.sourcemapOutput,
        looseMode: bundleConfig.looseMode || false,
        dependsOn: bundleConfig.dependsOn || [],
        providesModuleNodeModules: bundleConfig.providesModuleNodeModules || [
          'react-native',
        ],
        hasteOptions: bundleConfig.hasteOptions || {},
        maxWorkers:
          bundleConfig.maxWorkers !== undefined
            ? Math.max(1, bundleConfig.maxWorkers)
            : this.envOptions.maxWorkers !== undefined
            ? Math.max(1, this.envOptions.maxWorkers)
            : Math.max(
                isCi ? Math.min(cpus().length - 1, 7) : cpus().length - 1,
                1
              ),
      };

      // Make sure the target platform is supported. Do not run this check when target is set
      // to server, since the initial configuration loading is done with `platform` set
      // to "".
      if (
        !this.platforms.includes(properties.platform) &&
        this.envOptions.bundleTarget !== 'server'
      ) {
        throw new Error(
          `Platform "${
            properties.platform
          }" is not supported - only: ${this.platforms
            .map(platform => `"${platform}"`)
            .join(', ')} are available.`
        );
      }

      return new OwnedBundle(
        name,
        properties,
        // TODO: move creation of base config to OwnedBundle#makeWebpackConfig
        this.getBaseWebpackConfig(runtime, this.envOptions, name, {
          server: this.server,
          bundles: {
            [name]: {
              entry: { entryFiles: properties.inputModuleNames },
              platform: properties.platform,
              root: properties.context,
              assetsDest: properties.assetsDestination || '',
              dev: properties.mode.startsWith('dev'),
              minify: properties.minify,
              providesModuleNodeModules: properties.providesModuleNodeModules,
              hasteOptions: properties.hasteOptions,
              maxWorkers: properties.maxWorkers,
              type: properties.format,
            },
          },
        }),
        bundleConfig.transform
          ? (config: webpack.Configuration) => {
              return bundleConfig.transform?.({
                bundleName: name,
                runtime,
                env: this.envOptions,
                config,
              });
            }
          : undefined
      );
    });

    bundles.forEach(bundle => {
      if (bundle instanceof OwnedBundle) {
        this.ownedBundles.push(bundle);
      } else {
        this.externalBundles.push(bundle);
      }
    });

    return bundles;
  }

  /**
   * Construct instances of `OwnedBundle` or `ExternalBundle` based on supplied
   * in constructor `projectConfig`, sorted based on their type and dependencies
   * specified in `dependsOn`.
   *
   * @param runtime A `Runtime` instance.
   *
   * @returns Sorted array with `OwnedBundle | ExternalBundle` instances.
   */
  createBundlesSorted(
    runtime: Runtime,
    { skipHostCheck }: { skipHostCheck?: boolean } = {}
  ): Array<OwnedBundle | ExternalBundle> {
    const bundles = this.createBundles(runtime);

    const dlls: Set<string> = new Set();
    let host: string = '';
    const apps: string[] = [];

    const addDllDependencies = (deps: string[]) => {
      deps.forEach(dependencyName => {
        const dependencyBundle = bundles.find(
          bundle => bundle.name === dependencyName
        );
        addDllDependencies(dependencyBundle?.properties.dependsOn || []);
        dlls.add(dependencyName);
      });
    };

    for (const bundle of bundles) {
      if (bundle.properties.type === 'dll') {
        addDllDependencies(bundle.properties.dependsOn || []);
        dlls.add(bundle.name);
      } else if (['index', 'main', 'host'].includes(bundle.name)) {
        host = bundle.name;
      } else {
        apps.push(bundle.name);
      }
    }

    if (!host && !skipHostCheck) {
      throw new Error(
        'Cannot find webpack config `index` nor `host`. Make sure you have bundle config for `index` or `host'
      );
    }

    const sortedBundleNames = [...dlls.values(), host, ...apps].filter(Boolean);
    return sortedBundleNames
      .map(bundleName => {
        return bundles.find(bundle => bundle.name === bundleName);
      })
      .filter(Boolean) as Array<OwnedBundle | ExternalBundle>;
  }
}